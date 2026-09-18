import { assertPublicUrl, readBodyCapped } from 'services/document/image-captions/fetch-remote-image';
import { fetchFollowingPublicRedirects } from 'services/document/image-captions/fetch-url-text';
import { ImportRefusal } from 'services/import/types';

/**
 * Fetches the HTML of a public page for the URL import.
 *
 * The SSRF guard, the manual redirect walk and the streaming size cap all come
 * from the link-content fetcher (`services/document/image-captions`) rather than
 * being written again here: a second implementation is a second thing to get
 * wrong. What this module adds is the import's own vocabulary — a refusal the
 * route can answer with, instead of the `null` that caption fetching degrades to.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** How much of the body is scanned for a `<meta charset>` when the header has none. */
const META_CHARSET_SCAN_BYTES = 2048;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_HTML_BYTES = positiveIntFromEnv(process.env.IMPORT_WEB_MAX_BYTES, DEFAULT_MAX_BYTES);

export interface FetchedPage {
  html: string;
  /** The URL after redirects — what relative links in the page resolve against. */
  finalUrl: string;
  contentType: string;
}

export interface FetchPageOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Charset labels that are already what `Buffer.toString('utf-8')` assumes. */
const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'us-ascii', 'ascii']);

function charsetFromContentType(contentType: string): string | null {
  const match = contentType.match(/charset\s*=\s*"?([^;"\s]+)"?/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Reads the charset a document declares about itself. Only the head of the body
 * is scanned, and as latin1: every encoding we can decode is ASCII-compatible in
 * its first bytes, which is exactly why the declaration is readable at all.
 */
function charsetFromMeta(buffer: Buffer): string | null {
  const head = buffer.subarray(0, META_CHARSET_SCAN_BYTES).toString('latin1');
  const direct = head.match(/<meta[^>]+charset\s*=\s*["']?([a-z0-9_\-:]+)/i);
  if (direct) return direct[1].toLowerCase();
  const httpEquiv = head.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/i);
  return httpEquiv ? charsetFromContentType(httpEquiv[0]) : null;
}

/**
 * Turns the fetched bytes into a string, honouring a non-UTF-8 charset from the
 * header or from `<meta charset>`. Exported so the decoding can be tested without
 * a network round trip.
 */
export function decodeHtmlBody(buffer: Buffer, contentType: string): string {
  const declared = charsetFromContentType(contentType) ?? charsetFromMeta(buffer);
  if (!declared || UTF8_LABELS.has(declared)) return buffer.toString('utf-8');

  try {
    // TextDecoder knows the WHATWG encoding labels (euc-kr, shift_jis, …); an
    // unknown label throws, and a page we cannot decode is better read as UTF-8
    // with replacement characters than not read at all.
    return new TextDecoder(declared).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('xhtml');
}

export async function fetchPage(rawUrl: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? MAX_HTML_BYTES;

  // Two failures the manager can act on differently: a string that is not a URL
  // we can fetch at all, and a URL that resolves somewhere we refuse to go.
  // `assertPublicUrl` collapses both into null, so the syntax check runs first.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ImportRefusal(400, 'import_url_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImportRefusal(400, 'import_url_invalid');
  }

  const url = await assertPublicUrl(parsed.href);
  if (!url) throw new ImportRefusal(422, 'import_url_blocked');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // A page that times out or refuses the connection is the manager's problem
    // to act on — a slow site, a host that is down, a name that does not
    // resolve — not a bug in the conversion, so it is a refusal rather than the
    // generic `import_conversion_failed` a plain Error would become.
    const response = await fetchFollowingPublicRedirects(url, controller.signal, {
      fetchImpl: opts.fetchImpl,
    }).catch((error: Error) => {
      const timedOut = error.name === 'AbortError' || controller.signal.aborted;
      throw new ImportRefusal(422, 'import_url_unreadable', { reason: timedOut ? 'timeout' : 'network' });
    });
    // null means a redirect pointed at a non-public host, or the chain ran too
    // long — from the manager's side both are "this URL will not open for us".
    if (!response) throw new ImportRefusal(422, 'import_url_blocked');

    if (!response.ok) {
      const status = response.status;
      const blocked = status === 401 || status === 403 || status === 429;
      throw new ImportRefusal(422, blocked ? 'import_url_blocked' : 'import_url_unreadable', { status });
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!isHtmlContentType(contentType)) {
      throw new ImportRefusal(415, 'import_unsupported_file', { contentType: contentType || 'unknown' });
    }

    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength && declaredLength > maxBytes) {
      throw new ImportRefusal(413, 'import_too_large', { maxBytes });
    }

    // Enforce the cap while streaming so a missing or lying content-length
    // cannot make us buffer more than `maxBytes`.
    const buffer = await readBodyCapped(response, maxBytes);
    if (!buffer) {
      // readBodyCapped returns null for "over the cap" and for "empty" alike; an
      // explicitly empty body is unreadable rather than too large.
      if (response.headers.get('content-length') === '0') {
        throw new ImportRefusal(422, 'import_url_unreadable');
      }
      throw new ImportRefusal(413, 'import_too_large', { maxBytes });
    }

    return {
      html: decodeHtmlBody(buffer, contentType),
      finalUrl: response.url || url.href,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}
