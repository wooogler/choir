import fs from 'node:fs';
import path from 'node:path';
import { classifyImageSrc, extractImageRefs, resolveLocalImageRepoPath } from 'services/document/image-refs';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const DEFAULT_MAX_IMAGES = 2;

export interface ReplyImage {
  imageUrl: string;
  altText: string;
}

export interface RetrievedSection {
  pageContent?: string;
  fileName?: string;
}

/**
 * Resolves images referenced by retrieved sections to public image URLs for an
 * inline Slack image block. Remote URLs are used directly; local (committed)
 * images are exposed via the public docs asset route, which requires
 * DOCS_BASE_URL (and a publicly reachable host — Slack fetches the URL itself,
 * so this won't render for a localhost dev server). Deduped by src and capped.
 */
export function collectReplyImages(
  workspaceId: string,
  sections: RetrievedSection[],
  maxImages = DEFAULT_MAX_IMAGES,
): ReplyImage[] {
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(workspaceId);
  const seen = new Set<string>();
  const out: ReplyImage[] = [];

  for (const section of sections) {
    if (out.length >= maxImages) break;

    for (const ref of extractImageRefs(section.pageContent || '')) {
      if (out.length >= maxImages) break;
      if (seen.has(ref.src)) continue;
      seen.add(ref.src);

      const kind = classifyImageSrc(ref.src);
      if (kind === 'remote') {
        out.push({ imageUrl: ref.src, altText: ref.alt || 'image' });
        continue;
      }
      if (kind === 'data' || !baseUrl) continue;

      const repoPath = resolveLocalImageRepoPath(section.fileName || '', ref.src);
      if (!repoPath || !IMAGE_EXTENSIONS.has(path.posix.extname(repoPath).slice(1).toLowerCase())) continue;

      const absolute = path.resolve(repoRoot, repoPath);
      if (!absolute.startsWith(path.resolve(repoRoot)) || !fs.existsSync(absolute)) continue;

      const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
      out.push({
        imageUrl: `${baseUrl}/api/docs/${encodeURIComponent(workspaceId)}/${encoded}`,
        altText: ref.alt || path.posix.basename(repoPath),
      });
    }
  }

  return out;
}
