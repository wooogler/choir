import { extractImageRefs, imageRefKey } from 'services/document/image-refs';
import type { MarkdownItem } from 'services/document/markdown-section-splitter';
import { extractDocumentUrls, urlRefKey } from 'services/document/url-refs';
import { ImageCaptionCache } from './caption-cache';

/**
 * Appends cached enrichments to section items so the QMD text index can retrieve
 * them: image captions (for items containing images) and linked-page summaries
 * (for items containing external URLs). Synchronous and cache-only (no
 * LLM/network) — safe inside the section-build path. Items with nothing cached
 * are returned unchanged.
 */
export function injectCachedCaptions(items: MarkdownItem[], workspaceId: string, docRelPath: string): MarkdownItem[] {
  const cache = ImageCaptionCache.get(workspaceId);
  cache.ensureLoaded();

  return items.map((item) => {
    const additions: string[] = [];

    for (const ref of extractImageRefs(item.content)) {
      const key = imageRefKey(docRelPath, ref.src);
      const entry = key ? cache.lookupByRef(key) : null;
      if (entry?.caption) additions.push(entry.caption);
    }

    for (const ref of extractDocumentUrls(item.content)) {
      const entry = cache.lookupByRef(urlRefKey(ref.url));
      if (entry?.status === 'ok' && entry.caption) {
        additions.push(`Linked page (${ref.url}): ${entry.caption}`);
      }
    }

    if (additions.length === 0) return item;
    return { ...item, content: `${item.content}\n\n${additions.join('\n\n')}` };
  });
}
