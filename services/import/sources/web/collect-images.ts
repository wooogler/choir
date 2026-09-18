import crypto from 'node:crypto';
import { Logger } from 'services/common/logger';
import { type RemoteImage, fetchRemoteImage } from 'services/document/image-captions/fetch-remote-image';
import type { RejectedAsset } from 'services/google/gdocs-delta';
import type { ImportAsset } from 'services/import/types';

/**
 * Downloads the images a converted page points at and turns them into assets
 * that land in the same commit as the markdown.
 *
 * Everything here comes from a page nobody in the workspace controls, so the
 * claimed content type is ignored in favour of magic bytes (the same rule the
 * Google Docs import applies in `gdocs-delta.ts`), and every limit — count,
 * per-image size, total size — is enforced before anything is kept. Images that
 * do not survive are reported as `RejectedAsset` and their references are taken
 * out of the markdown, so a committed document never points at nothing.
 */

const DEFAULT_MAX_IMAGES = 20;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Per-image cap, matching `save-asset.ts` and the Docs import. */
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
/** Enough to keep the page's images arriving in parallel without hammering the host. */
const FETCH_CONCURRENCY = 4;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_IMAGES = positiveIntFromEnv(process.env.IMPORT_WEB_MAX_IMAGES, DEFAULT_MAX_IMAGES);

/**
 * Matches an inline image in markdown: `![alt](url)` or `![alt](<url> "title")`.
 *
 * A fresh regex per call because it is global and therefore carries `lastIndex`.
 * Image references are read off the markdown rather than the mdast so that what
 * we fetch is exactly what the document points at — including after a manager
 * has edited the draft in the preview editor.
 */
export function imageReferencePattern(): RegExp {
  return /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
}

/** Strips the angle brackets remark-stringify adds around awkward URLs. */
export function normalizeImageTarget(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

/** Image URLs referenced in a markdown document, in order, de-duplicated. */
export function extractImageUrls(markdown: string): string[] {
  const seen = new Set<string>();
  const pattern = imageReferencePattern();
  let match = pattern.exec(markdown);
  while (match) {
    const url = normalizeImageTarget(match[2]);
    if (url) seen.add(url);
    match = pattern.exec(markdown);
  }
  return [...seen];
}

export interface CollectImagesOptions {
  maxImages?: number;
  maxTotalBytes?: number;
  /** Injection point for tests; defaults to the SSRF-guarded `fetchRemoteImage`. */
  fetchImage?: (url: string) => Promise<RemoteImage | null>;
}

export interface CollectImagesResult {
  assets: ImportAsset[];
  /** Original image URL → repository asset path, for rewriting the markdown. */
  rewrite: Map<string, string>;
  rejected: RejectedAsset[];
}

/** Raster formats only, identified by magic bytes rather than a claimed type. */
function sniffImageType(bytes: Buffer): { contentType: string; extension: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) {
    return { contentType: 'image/gif', extension: 'gif' };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

/**
 * Where an asset lives in the repository. Content-addressed with the same hash
 * length and layout as the web editor's upload path (`docs-editor/save-asset.ts`)
 * so the identical bytes resolve to one file whichever way they arrived.
 */
function assetPath(bytes: Buffer, extension: string): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40);
  return `assets/${hash}.${extension}`;
}

/** Decodes a `data:image/…;base64,…` source without going near the network. */
function decodeDataUri(url: string): RemoteImage | null {
  const match = url.match(/^data:([^;,]+)(;[^,]*)?,([\s\S]*)$/i);
  if (!match) return null;

  const contentType = match[1].toLowerCase();
  const isBase64 = (match[2] || '').toLowerCase().includes(';base64');
  try {
    const bytes = isBase64
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3].replace(/\s/g, '')), 'latin1');
    return bytes.length > 0 ? { bytes, contentType } : null;
  } catch {
    return null;
  }
}

/** Runs `worker` over `items` with a bounded number in flight, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function collectImages(
  imageUrls: string[],
  opts: CollectImagesOptions = {},
): Promise<CollectImagesResult> {
  const maxImages = opts.maxImages ?? MAX_IMAGES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const fetchImage = opts.fetchImage ?? fetchRemoteImage;

  const unique = [...new Set(imageUrls.filter(Boolean))];
  const accepted = unique.slice(0, maxImages);
  const overflow = unique.slice(maxImages);

  const assets: ImportAsset[] = [];
  const rewrite = new Map<string, string>();
  const rejected: RejectedAsset[] = [];

  // Fetch in parallel but decide in document order, so the total-size budget is
  // spent on the images the reader meets first rather than on whoever answered
  // fastest — and so the same page always converts the same way.
  const fetched = await mapWithConcurrency(accepted, FETCH_CONCURRENCY, async (url) => {
    if (/^data:/i.test(url)) return decodeDataUri(url);
    try {
      return await fetchImage(url);
    } catch (error) {
      Logger.info('collectImages: image fetch failed, dropping the reference', {
        url,
        error: (error as Error).message,
      });
      return null;
    }
  });

  const storedPaths = new Set<string>();
  let totalBytes = 0;

  for (let index = 0; index < accepted.length; index += 1) {
    const url = accepted[index];
    const image = fetched[index];

    if (!image) {
      rejected.push({ reason: 'unsupported_image_type', contentType: 'unknown', bytes: 0 });
      continue;
    }
    if (image.bytes.length > MAX_ASSET_BYTES) {
      rejected.push({ reason: 'image_too_large', contentType: image.contentType, bytes: image.bytes.length });
      continue;
    }

    const sniffed = sniffImageType(image.bytes);
    if (!sniffed) {
      rejected.push({ reason: 'unsupported_image_type', contentType: image.contentType, bytes: image.bytes.length });
      continue;
    }

    const path = assetPath(image.bytes, sniffed.extension);
    if (storedPaths.has(path)) {
      // The same bytes twice on one page: one file, two references.
      rewrite.set(url, path);
      continue;
    }

    if (totalBytes + image.bytes.length > maxTotalBytes) {
      rejected.push({ reason: 'image_too_large', contentType: sniffed.contentType, bytes: image.bytes.length });
      continue;
    }

    totalBytes += image.bytes.length;
    storedPaths.add(path);
    assets.push({ path, bytes: image.bytes, contentType: sniffed.contentType });
    rewrite.set(url, path);
  }

  for (const url of overflow) {
    rejected.push({ reason: 'too_many_images', contentType: /^data:/i.test(url) ? 'data' : 'unknown', bytes: 0 });
  }

  return { assets, rewrite, rejected };
}

/**
 * Points the markdown at the committed assets, and takes out the references that
 * did not survive.
 *
 * A dropped image leaves its alt text behind as plain words when it had any: the
 * sentence the author wrote about the picture is usually still worth reading,
 * and a document that silently points at a missing file is not.
 */
export function rewriteImageReferences(markdown: string, rewrite: Map<string, string>, dropped: Set<string>): string {
  const pattern = imageReferencePattern();
  const rewritten = markdown.replace(pattern, (match, alt: string, target: string, doubleTitle, singleTitle) => {
    const url = normalizeImageTarget(target);

    const replacement = rewrite.get(url);
    if (replacement) {
      const title = doubleTitle ?? singleTitle;
      return title ? `![${alt}](${replacement} "${title}")` : `![${alt}](${replacement})`;
    }

    if (dropped.has(url)) return alt.trim();
    return match;
  });

  return rewritten
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
