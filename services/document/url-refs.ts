export interface UrlRef {
  url: string;
  /** Anchor text from `[text](url)`, when available. */
  text: string;
}

// Markdown link `[text](url)` (images are stripped first), and bare/autolinks.
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)[^)]*\)/g;
const BARE_URL = /(?:^|[\s(<])(https?:\/\/[^\s)>\]"'`]+)/g;
const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)/g;

// Non-page resources we should not try to fetch and summarize.
const SKIP_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'pdf',
  'zip',
  'gz',
  'tar',
  'mp4',
  'mov',
  'mp3',
  'wav',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
]);

function normalizeUrl(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  value = value.replace(/[).,;!?'"]+$/, ''); // strip trailing punctuation from bare URLs
  if (!/^https?:\/\//i.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const ext = parsed.pathname.includes('.') ? (parsed.pathname.split('.').pop() || '').toLowerCase() : '';
  if (ext && SKIP_EXTENSIONS.has(ext)) return null;
  return parsed.href;
}

/**
 * Extracts external http(s) page URLs referenced by a markdown document (from
 * markdown links, autolinks, and bare URLs). Image references are ignored (the
 * image pipeline handles those), as are non-page resources (pdf/zip/media/...).
 * Deduplicated and capped.
 */
export function extractDocumentUrls(markdown: string, maxUrls = 10): UrlRef[] {
  const withoutImages = markdown.replace(IMAGE_MARKDOWN, ' ');
  const found = new Map<string, string>();

  for (const match of withoutImages.matchAll(MARKDOWN_LINK)) {
    const url = normalizeUrl(match[2]);
    if (url && !found.has(url)) found.set(url, (match[1] || '').trim());
  }
  for (const match of withoutImages.matchAll(BARE_URL)) {
    const url = normalizeUrl(match[1]);
    if (url && !found.has(url)) found.set(url, '');
  }

  return [...found.entries()].slice(0, maxUrls).map(([url, text]) => ({ url, text }));
}

/** Cache key for a link summary, parallel to imageRefKey. */
export function urlRefKey(url: string): string {
  return `link:${url}`;
}
