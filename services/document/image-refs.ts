import path from 'node:path';

export interface ImageRef {
  /** Alt text from `![alt](src)`. */
  alt: string;
  /** Raw src as written in the markdown. */
  src: string;
}

export type ImageSrcKind = 'remote' | 'data' | 'local';

// Markdown image: ![alt](src) or ![alt](<src> "title") or ![alt](src "title").
// Groups: 1=alt, 2=src (maybe <bracketed>), 3=optional title (incl. leading space).
const IMAGE_MD = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+["'][^"']*["'])?)\s*\)/g;

function unwrapSrc(rawSrc: string): string {
  const src = rawSrc.trim();
  return src.startsWith('<') && src.endsWith('>') ? src.slice(1, -1).trim() : src;
}

/** Extracts markdown image references (`![alt](src)`) from a document. */
export function extractImageRefs(markdown: string): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const match of markdown.matchAll(IMAGE_MD)) {
    const src = unwrapSrc(match[2]);
    if (!src) continue;
    refs.push({ alt: (match[1] || '').trim(), src });
  }
  return refs;
}

/**
 * Whether an image's existing alt text is safe to overwrite with a generated
 * caption: empty, or junk like a pasted number ("1.00"). A meaningful
 * author-written alt is preserved.
 */
export function isReplaceableAlt(alt: string): boolean {
  const trimmed = alt.trim();
  if (!trimmed) return true;
  if (/^[\d.\s]+$/.test(trimmed)) return true;
  return false;
}

/**
 * Sets the alt text of captioned images to their short caption, so the caption
 * is visible in the editor/rendered markdown. Only rewrites images that resolve
 * to a caption and whose current alt is replaceable; the src token and any title
 * are preserved exactly. Returns whether anything changed.
 */
export function applyImageCaptions(
  markdown: string,
  docRelPath: string,
  captionForKey: (refKey: string) => string | null,
): { markdown: string; changed: boolean } {
  let changed = false;
  const next = markdown.replace(IMAGE_MD, (full, alt: string, srcToken: string, title: string) => {
    const src = unwrapSrc(srcToken);
    const key = src ? imageRefKey(docRelPath, src) : null;
    if (!key) return full;
    const caption = captionForKey(key);
    if (!caption || !isReplaceableAlt(alt) || alt.trim() === caption.trim()) return full;
    changed = true;
    return `![${caption}](${srcToken.trim()}${title})`;
  });
  return { markdown: next, changed };
}

export function classifyImageSrc(src: string): ImageSrcKind {
  if (/^data:/i.test(src)) return 'data';
  if (/^(https?:)?\/\//i.test(src) || /^https?:/i.test(src)) return 'remote';
  return 'local';
}

/** Strips a query string / fragment from a path-like src. */
function stripQueryHash(src: string): string {
  return src.split('#')[0].split('?')[0];
}

/**
 * Resolves a local image `src` (as written in a doc) to a repo-root-relative
 * POSIX path, resolving `..`/`.` against the document's directory and treating
 * a leading `/` as repo-root-relative. Returns null if the result escapes the
 * repo root. This is the server-side mirror of the editor's resolveAssetDisplayUrl.
 */
export function resolveLocalImageRepoPath(docRelPath: string, src: string): string | null {
  const clean = stripQueryHash(src).trim();
  if (!clean) return null;

  const docDir = path.posix.dirname(docRelPath.split(path.sep).join(path.posix.sep));
  const joined = clean.startsWith('/')
    ? clean.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(docDir === '.' ? '' : docDir, clean));

  if (!joined || joined.startsWith('..')) return null;
  return joined;
}

/**
 * A stable cache key for an image reference that does not require reading its
 * bytes: the repo-relative path for local images, the trimmed URL for remote.
 * Used to look up cached captions during (synchronous) section building.
 */
export function imageRefKey(docRelPath: string, src: string): string | null {
  const kind = classifyImageSrc(src);
  if (kind === 'remote') return `url:${src.trim()}`;
  if (kind === 'data') return null; // inline data: not worth caching by value
  const repoPath = resolveLocalImageRepoPath(docRelPath, src);
  return repoPath ? `local:${repoPath}` : null;
}
