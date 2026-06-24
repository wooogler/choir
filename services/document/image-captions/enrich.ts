import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import {
  type ImageRef,
  applyImageCaptions,
  classifyImageSrc,
  extractImageRefs,
  imageRefKey,
  resolveLocalImageRepoPath,
} from 'services/document/image-refs';
import { extractDocumentUrls, urlRefKey } from 'services/document/url-refs';
import { GithubService } from 'services/github';
import { createChatCompletion } from 'services/llm/completions';
import { deriveShortCaption, generateImageCaption } from 'services/llm/vision-caption';
import { getRetrievalProvider } from 'services/retrieval';
import { scheduleQmdWarmup } from 'services/retrieval/warmup';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { type CaptionEntry, ImageCaptionCache } from './caption-cache';
import { fetchRemoteImage } from './fetch-remote-image';
import { fetchUrlText } from './fetch-url-text';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface EnrichResult {
  generated: number;
  reusedByHash: number;
  unavailable: number;
  docsCaptioned: number;
  linksSummarized: number;
  linksUnavailable: number;
}

export interface EnrichOptions {
  /**
   * When set, generated captions are written back into the documents as the
   * images' alt text (a visible figure caption) and committed to GitHub on the
   * user's behalf. Omitted for background syncs, which only update the index.
   */
  userId?: string;
}

function contentTypeForPath(filePath: string): string | null {
  const ext = path.posix.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? null;
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40);
}

/** The visible alt-text caption for an image, only for successfully described images. */
function shortCaptionForKey(cache: ImageCaptionCache, refKey: string): string | null {
  const entry = cache.lookupByRef(refKey);
  if (!entry || entry.status !== 'ok' || !entry.caption) return null;
  return entry.shortCaption?.trim() || deriveShortCaption(entry.caption);
}

async function acquireImageBytes(params: {
  repoRoot: string;
  docRelPath: string;
  ref: ImageRef;
}): Promise<{ bytes: Buffer; contentType: string } | null> {
  const kind = classifyImageSrc(params.ref.src);

  if (kind === 'data') return null; // inline data: skip captioning for the first cut
  if (kind === 'remote') {
    return await fetchRemoteImage(params.ref.src);
  }

  const repoPath = resolveLocalImageRepoPath(params.docRelPath, params.ref.src);
  if (!repoPath) return null;
  const contentType = contentTypeForPath(repoPath);
  if (!contentType) return null;

  const absolute = path.resolve(params.repoRoot, repoPath);
  if (!absolute.startsWith(path.resolve(params.repoRoot)) || !fs.existsSync(absolute)) return null;

  try {
    const bytes = await fs.promises.readFile(absolute);
    return bytes.length > 0 ? { bytes, contentType } : null;
  } catch {
    return null;
  }
}

function listMarkdownFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(repoRoot, full).split(path.sep).join(path.posix.sep));
      }
    }
  }
  return out;
}

function altOnlyEntry(alt: string, status: CaptionEntry['status']): CaptionEntry {
  return {
    caption: alt ? `Image: ${alt}` : '',
    status,
    updatedAt: new Date().toISOString(),
  };
}

/** Generates+caches captions for one document's images. Returns true if any cache entry changed. */
async function captionDocumentImages(params: {
  workspaceId: string;
  repoRoot: string;
  docRelPath: string;
  refs: ImageRef[];
  cache: ImageCaptionCache;
  result: EnrichResult;
}): Promise<boolean> {
  const { workspaceId, repoRoot, docRelPath, refs, cache, result } = params;
  let cacheChanged = false;

  for (const ref of refs) {
    const key = imageRefKey(docRelPath, ref.src);
    if (!key || cache.hasRef(key)) continue;

    const acquired = await acquireImageBytes({ repoRoot, docRelPath, ref });
    if (!acquired) {
      // Remote unreachable → cache an alt-only entry so we don't re-fetch every
      // run. A local miss is more likely a sync race, so skip and retry later.
      if (classifyImageSrc(ref.src) === 'remote') {
        const pseudoHash = `noimg:${crypto.createHash('sha1').update(key).digest('hex')}`;
        cache.put(key, pseudoHash, altOnlyEntry(ref.alt, 'unavailable'));
        result.unavailable += 1;
        cacheChanged = true;
      }
      continue;
    }

    const hash = hashBytes(acquired.bytes);
    const existing = cache.getByHash(hash);
    if (existing) {
      cache.put(key, hash, existing); // same image already described elsewhere
      result.reusedByHash += 1;
      cacheChanged = true;
      continue;
    }

    try {
      const dataUrl = `data:${acquired.contentType};base64,${acquired.bytes.toString('base64')}`;
      const { shortCaption, indexText, model } = await generateImageCaption({ workspaceId, dataUrl, alt: ref.alt });
      cache.put(key, hash, {
        caption: indexText,
        shortCaption,
        status: 'ok',
        model,
        bytes: acquired.bytes.length,
        updatedAt: new Date().toISOString(),
      });
      result.generated += 1;
      cacheChanged = true;
    } catch (error) {
      // Do not cache failures (missing key / rate limit / transient) so a later
      // run can retry; the image is just un-captioned for now.
      Logger.warn('enrichWorkspaceImageCaptions: caption generation failed', {
        workspaceId,
        docRelPath,
        src: ref.src,
        error: (error as Error).message,
      });
    }
  }

  return cacheChanged;
}

async function summarizeUrl(params: {
  workspaceId: string;
  url: string;
  title: string;
  text: string;
}): Promise<string> {
  const summary = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          'You write concise, factual summaries of web pages for a documentation search index. Output plain text only.',
      },
      {
        role: 'user',
        content: `A document links to this page. Summarize it in 3-6 sentences, capturing the key facts and topics someone might search for. Do not add commentary.\n\nURL: ${params.url}\nTitle: ${params.title}\n\nContent:\n${params.text}`,
      },
    ],
    { workspaceId: params.workspaceId, purpose: 'qa', max_tokens: 350, function_name: 'summarizeUrl' },
  );
  const trimmed = summary.trim();
  if (!trimmed) throw new Error('Empty URL summary');
  return trimmed;
}

/** Fetches+summarizes a document's external links into the cache. Returns true if any cache entry changed. */
async function summarizeDocumentUrls(params: {
  workspaceId: string;
  docRelPath: string;
  content: string;
  cache: ImageCaptionCache;
  result: EnrichResult;
}): Promise<boolean> {
  const { workspaceId, docRelPath, content, cache, result } = params;
  let cacheChanged = false;

  for (const ref of extractDocumentUrls(content)) {
    const key = urlRefKey(ref.url);
    if (cache.hasRef(key)) continue;

    const fetched = await fetchUrlText(ref.url);
    if (!fetched) {
      // Unreachable / non-HTML / blocked → cache an empty entry so we don't refetch every run.
      cache.put(key, `nolink:${crypto.createHash('sha1').update(key).digest('hex')}`, {
        caption: '',
        status: 'unavailable',
        updatedAt: new Date().toISOString(),
      });
      result.linksUnavailable += 1;
      cacheChanged = true;
      continue;
    }

    try {
      const summary = await summarizeUrl({ workspaceId, url: ref.url, title: fetched.title, text: fetched.text });
      cache.put(key, `link:${crypto.createHash('sha1').update(ref.url).digest('hex')}`, {
        caption: summary,
        status: 'ok',
        updatedAt: new Date().toISOString(),
      });
      result.linksSummarized += 1;
      cacheChanged = true;
    } catch (error) {
      // Do not cache failures so a later run can retry.
      Logger.warn('enrichWorkspaceImageCaptions: url summary failed', {
        workspaceId,
        docRelPath,
        url: ref.url,
        error: (error as Error).message,
      });
    }
  }

  return cacheChanged;
}

/** Writes visible alt-text captions into a document and commits them to GitHub. Returns true if committed. */
async function writeVisibleCaptions(params: {
  workspaceId: string;
  userId: string;
  docRelPath: string;
  content: string;
  cache: ImageCaptionCache;
}): Promise<boolean> {
  const { workspaceId, userId, docRelPath, content, cache } = params;
  const { markdown, changed } = applyImageCaptions(content, docRelPath, (key) => shortCaptionForKey(cache, key));
  if (!changed) return false;

  const repoInfo = await getGithubRepo(workspaceId);
  if (!repoInfo) return false;

  try {
    await GithubService.getInstance().updateMarkdownFile({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: docRelPath,
      content: markdown,
      message: `Add image captions to ${docRelPath}`,
      branch: repoInfo.branch,
      workspaceId,
      userId,
    });
    // Update the mirror so the editor shows the captions immediately; this also
    // rebuilds the section files with the injected index captions.
    await WorkspaceMirrorService.getInstance().writeMarkdownFile(workspaceId, docRelPath, markdown);
    return true;
  } catch (error) {
    Logger.warn('enrichWorkspaceImageCaptions: failed to commit visible captions', {
      workspaceId,
      docRelPath,
      error: (error as Error).message,
    });
    return false;
  }
}

/**
 * Scans every markdown document in the workspace mirror for image references,
 * generates a caption for each not-yet-cached image (local bytes or a
 * best-effort remote fetch), injects the full caption into the QMD section
 * index, and — when a userId is provided — writes a short visible caption into
 * the image's alt text and commits it. Caching by content hash means only
 * genuinely new images cost a vision call.
 *
 * Best-effort and non-blocking by design — fired after a save or sync.
 */
export async function enrichWorkspaceImageCaptions(
  workspaceId: string,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const mirror = WorkspaceMirrorService.getInstance();
  const repoRoot = mirror.getRepoRoot(workspaceId);
  const result: EnrichResult = {
    generated: 0,
    reusedByHash: 0,
    unavailable: 0,
    docsCaptioned: 0,
    linksSummarized: 0,
    linksUnavailable: 0,
  };
  if (!fs.existsSync(repoRoot)) return result;

  const cache = ImageCaptionCache.get(workspaceId);
  cache.ensureLoaded();

  const docsNeedingSectionRebuild = new Set<string>();
  let indexChanged = false;

  for (const docRelPath of listMarkdownFiles(repoRoot)) {
    let content: string;
    try {
      content = await fs.promises.readFile(path.join(repoRoot, docRelPath), 'utf-8');
    } catch {
      continue;
    }

    const refs = extractImageRefs(content);

    const imagesChanged =
      refs.length > 0 ? await captionDocumentImages({ workspaceId, repoRoot, docRelPath, refs, cache, result }) : false;
    const urlsChanged = await summarizeDocumentUrls({ workspaceId, docRelPath, content, cache, result });

    if (imagesChanged || urlsChanged) {
      docsNeedingSectionRebuild.add(docRelPath);
      indexChanged = true;
    }

    // Visible captions (alt-text write-back + commit) when running on behalf of a user.
    if (opts.userId) {
      const committed = await writeVisibleCaptions({
        workspaceId,
        userId: opts.userId,
        docRelPath,
        content,
        cache,
      });
      if (committed) {
        // writeMarkdownFile already rebuilt this doc's sections with injection.
        docsNeedingSectionRebuild.delete(docRelPath);
        indexChanged = true;
        result.docsCaptioned += 1;
      }
    }
  }

  await cache.save();

  if (!indexChanged) return result;

  for (const docRelPath of docsNeedingSectionRebuild) {
    try {
      await mirror.rebuildSectionsForFile(workspaceId, docRelPath);
    } catch (error) {
      Logger.warn('enrichWorkspaceImageCaptions: failed to rebuild sections', {
        workspaceId,
        docRelPath,
        error: (error as Error).message,
      });
    }
  }

  // Drop the cached store so the next warm-up re-syncs and re-embeds the
  // changed section files.
  const provider = getRetrievalProvider() as { invalidateWorkspace?: (id: string) => Promise<void> };
  await provider.invalidateWorkspace?.(workspaceId);
  scheduleQmdWarmup({ workspaceId, reason: 'image-caption-enrich' });

  Logger.info('enrichWorkspaceImageCaptions: completed', { workspaceId, ...result });
  return result;
}
