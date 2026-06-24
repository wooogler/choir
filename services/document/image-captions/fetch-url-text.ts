import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Logger } from 'services/common/logger';
import { assertPublicUrl } from './fetch-remote-image';

const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 12000;

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
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'CHOIR-docs-bot/1.0' },
    });
    if (!response.ok) return null;

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('xhtml')) return null;

    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength && declaredLength > MAX_HTML_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_HTML_BYTES) return null;

    // A bare VirtualConsole (no listeners) silences jsdom's parse warnings.
    const dom = new JSDOM(buffer.toString('utf-8'), { url: url.href, virtualConsole: new VirtualConsole() });
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
