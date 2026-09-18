/**
 * P0 measurement 3 — the deterministic web pipeline from docs/pdf-web-import.md §5,
 * with no LLM anywhere:
 *
 *   fetch → JSDOM → Readability(.content) → rehype-parse (fragment)
 *         → rehype-remark → remark-gfm → remark-stringify
 *
 * plus absolutising of link and image URLs. Falls back to <main> → <article>
 * → <body> when Readability returns nothing, exactly as the plan specifies, and
 * reports which path was taken.
 *
 *   npx tsx scripts/spike-import/web-convert.ts            # the three P0 pages
 *   npx tsx scripts/spike-import/web-convert.ts <url> …    # any other page
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { OUT_DIR, SCRATCH, ensureDirs, fmt } from './spike-common';

const DEFAULT_URLS = [
  'https://github.com/mozilla/readability',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table',
  'https://policies.mit.edu/policies-procedures/110-privacy-and-disclosure-personal-information/112-privacy-personal',
  // a section index rather than a leaf — kept because it shows the failure mode
  'https://policies.mit.edu/policies-procedures/110-privacy-and-disclosure-personal-information',
];

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_BYTES = 5 * 1024 * 1024;

interface FetchResult {
  status: number;
  contentType: string;
  html: string;
  bytes: number;
  ms: number;
  finalUrl: string;
}

async function fetchPage(url: string): Promise<FetchResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    html: buf.subarray(0, MAX_BYTES).toString('utf8'),
    bytes: buf.length,
    ms: Date.now() - t0,
    finalUrl: res.url || url,
  };
}

function absolutize(container: Element, base: string) {
  const fix = (el: Element, attr: string) => {
    const v = el.getAttribute(attr);
    if (!v || /^(data:|mailto:|javascript:|#)/i.test(v)) return;
    try {
      el.setAttribute(attr, new URL(v, base).toString());
    } catch {
      /* leave it */
    }
  };
  for (const el of Array.from(container.querySelectorAll('a[href]'))) fix(el, 'href');
  for (const el of Array.from(container.querySelectorAll('img[src]'))) fix(el, 'src');
  for (const el of Array.from(container.querySelectorAll('img[srcset]'))) el.removeAttribute('srcset');
}

async function htmlToMarkdown(html: string, baseUrl: string) {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');

  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;
  // Readability mutates its document, so give it a clone.
  const article = new Readability(doc.cloneNode(true) as Document).parse();

  let contentHtml = article?.content ?? '';
  let path_: 'readability' | 'main' | 'article' | 'body' | 'none' = 'readability';
  if (!contentHtml || contentHtml.replace(/<[^>]+>/g, '').trim().length < 50) {
    for (const sel of ['main', 'article', 'body'] as const) {
      const el = doc.querySelector(sel);
      if (el?.textContent && el.textContent.trim().length > 50) {
        contentHtml = el.innerHTML;
        path_ = sel;
        break;
      }
    }
    if (path_ === 'readability') path_ = 'none';
  }

  // absolutise inside the extracted fragment
  const frag = new JSDOM(`<div id="__root">${contentHtml}</div>`, { url: baseUrl });
  const root = frag.window.document.getElementById('__root');
  if (!root) throw new Error('fragment root missing');
  for (const el of Array.from(root.querySelectorAll('script, style, nav, footer, form, noscript'))) {
    el.remove();
  }
  absolutize(root, baseUrl);
  contentHtml = root.innerHTML;

  const { unified } = await import('unified');
  const rehypeParse = (await import('rehype-parse')).default;
  const rehypeRemark = (await import('rehype-remark')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const remarkStringify = (await import('remark-stringify')).default;

  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, { bullet: '-', fences: true, rule: '-' })
    .process(contentHtml);

  return {
    markdown: String(file),
    title: article?.title ?? doc.title ?? '',
    byline: article?.byline ?? null,
    readabilityChars: article?.content?.length ?? 0,
    extractionPath: path_,
  };
}

function analyse(markdown: string) {
  const headingLevels: Record<string, number> = {};
  for (const m of markdown.matchAll(/^(#{1,6}) /gm)) {
    const k = `h${m[1].length}`;
    headingLevels[k] = (headingLevels[k] || 0) + 1;
  }
  const tableRows = (markdown.match(/^\|/gm) || []).length;
  const tableSeparators = (markdown.match(/^\|[\s:|-]+\|\s*$/gm) || []).length;
  const listItems = (markdown.match(/^\s*(?:[-*+]|\d+\.) /gm) || []).length;
  const images = (markdown.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;
  const links = (markdown.match(/(?<!!)\[[^\]]*\]\([^)]*\)/g) || []).length;
  const codeFences = (markdown.match(/^```/gm) || []).length / 2;
  const relativeLinks = (markdown.match(/\]\((?!https?:|#|mailto:|data:)[^)]+\)/g) || []).length;
  const junkHits = [
    'Skip to main content',
    'Skip to content',
    'Sign in',
    'Sign up',
    'Cookie',
    'cookies',
    'Subscribe',
    'All rights reserved',
    '©',
  ].filter((needle) => markdown.includes(needle));
  return {
    chars: markdown.length,
    headingLevels,
    headings: Object.values(headingLevels).reduce((a, b) => a + b, 0),
    tables: tableSeparators,
    tableRows,
    listItems,
    images,
    links,
    relativeLinks,
    codeBlocks: codeFences,
    junk: junkHits,
  };
}

function slug(url: string) {
  const u = new URL(url);
  const tail = u.pathname.split('/').filter(Boolean).slice(-2).join('-') || 'index';
  return `${u.hostname}-${tail}`
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .toLowerCase();
}

async function main() {
  ensureDirs();
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
  const report: any[] = [];

  for (const url of urls) {
    console.log(`\n=== ${url} ===`);
    try {
      const fetched = await fetchPage(url);
      console.log(
        `fetch: ${fetched.status} ${fetched.contentType.split(';')[0]} ` +
          `${fmt(fetched.bytes / 1024)} KB in ${fetched.ms} ms`,
      );
      if (fetched.status >= 400) {
        report.push({ url, error: `HTTP ${fetched.status}` });
        continue;
      }
      const t0 = Date.now();
      const conv = await htmlToMarkdown(fetched.html, fetched.finalUrl);
      const convertMs = Date.now() - t0;
      const stats = analyse(conv.markdown);
      const out = path.join(OUT_DIR, `web-${slug(url)}.md`);
      fs.writeFileSync(out, conv.markdown);
      const row = {
        url,
        title: conv.title,
        extractionPath: conv.extractionPath,
        readabilityChars: conv.readabilityChars,
        htmlKb: +(fetched.bytes / 1024).toFixed(1),
        fetchMs: fetched.ms,
        convertMs,
        ...stats,
        out,
      };
      report.push(row);
      console.log(JSON.stringify(row, null, 2));
    } catch (err: any) {
      console.log(`FAILED: ${err?.message || err}`);
      report.push({ url, error: String(err?.message || err) });
    }
  }

  fs.writeFileSync(path.join(SCRATCH, 'web-report.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
