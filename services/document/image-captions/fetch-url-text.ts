import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Logger } from 'services/common/logger';
import { assertPublicUrl } from './fetch-remote-image';

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const MAX_REDIRECTS = 5;

/**
 * Follows redirects manually, re-running the SSRF guard on every hop's target.
 * `redirect: 'follow'` would let an attacker-controlled public page 302 to an
 * internal host (cloud metadata, intranet) that the initial guard never saw.
 */
async function fetchFollowingPublicRedirects(startUrl: URL, signal: AbortSignal): Promise<Response | null> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'CHOIR-docs-bot/1.0' },
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) return response;

    const nextUrl = await assertPublicUrl(new URL(location, currentUrl).href);
    if (!nextUrl) return null; // redirect points at a non-public host → refuse
    currentUrl = nextUrl;
  }
  return null; // too many redirects
}

export interface UrlContent {
  title: string;
  text: string;
}

/**
 * Fetches an HTML page (SSRF-guarded, timeout + size cap, HTML only) and extracts
 * its main readable text + title via Mozilla Readability. jsdom runs no scripts
 * and loads no subresources by default. Returns null on any failure so callers
 * degrade gracefully (skip the link).
 */
export async function fetchUrlText(rawUrl: string): Promise<UrlContent | null> {
  const url = await assertPublicUrl(rawUrl);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFollowingPublicRedirects(url, controller.signal);
    if (!response || !response.ok) return null;

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('xhtml')) return null;

    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength && declaredLength > MAX_HTML_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_HTML_BYTES) return null;

    // A bare VirtualConsole (no listeners) silences jsdom's parse warnings.
    const dom = new JSDOM(buffer.toString('utf-8'), {
      url: response.url || url.href,
      virtualConsole: new VirtualConsole(),
    });
    const article = new Readability(dom.window.document).parse();
    const title = (article?.title || dom.window.document.title || '').trim();

    let text = (article?.textContent || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) return null;
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

    return { title, text };
  } catch (error) {
    Logger.info('fetchUrlText: fetch/parse failed, skipping link', {
      url: rawUrl,
      error: (error as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
