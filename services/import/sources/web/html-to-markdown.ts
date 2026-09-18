import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { extractImageUrls } from './collect-images';

/**
 * Turns a fetched HTML page into repository markdown. Pure: no network, no
 * clock, no environment — the same page always converts to the same document.
 *
 * That determinism is the whole design of the web import (docs/pdf-web-import.md
 * 결정 5). Where the PDF path asks a model to transcribe, this path only moves
 * structure across: Readability decides what the article is, and rehype-remark
 * carries the surviving headings, lists, tables and code into markdown. Anything
 * the conversion loses is fixed by the manager in the preview editor, not by a
 * second guess here.
 */

/** Page furniture that carries no article text. Removed on the fallback path. */
const FURNITURE_SELECTOR =
  'script, style, noscript, nav, header, footer, aside, form, iframe, svg, template, [hidden], [aria-hidden="true"]';

/** Never worth converting, whichever path produced the content. */
const ALWAYS_REMOVED_SELECTOR = 'script, style, noscript, template';

/** Readability wraps its output in this container; it is not part of the article. */
const READABILITY_WRAPPER_ID = 'readability-page-1';

/**
 * How much text an article has to have before we believe Readability found one.
 *
 * The P0 spike caught it "succeeding" on a policy index page with 89 characters:
 * the page was a list of links, Readability scores links as navigation, and what
 * came back was a heading and nothing else. An article this short is a failure
 * dressed as an answer, so the page body is used instead.
 */
const MIN_ARTICLE_CHARS = 500;

/** Headings, for the rules that only apply inside one. */
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

export interface HtmlToMarkdownResult {
  markdown: string;
  title: string;
  /** Every image URL referenced in `markdown`, in order, de-duplicated. */
  imageUrls: string[];
  /** True when Readability found no article and the page body was used instead. */
  usedFallback: boolean;
}

function absolutize(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

/** Hrefs that mean "stay here" and must survive untouched. */
function isNonNavigationalHref(href: string): boolean {
  return href.startsWith('#') || /^(mailto|tel|sms):/i.test(href);
}

/** The first candidate of a `srcset`, which is the one an `src` would have been. */
function firstSrcsetCandidate(srcset: string): string | null {
  const first = srcset.split(',')[0]?.trim();
  const url = first?.split(/\s+/)[0];
  return url || null;
}

/**
 * Deletes comment nodes.
 *
 * rehype-remark carries a comment through as raw HTML, so MDN's 94 `<!--lit-node
 * 1-->` hydration markers land in the document — inside headings and table cells,
 * where they also break the structure around them. Nothing in a comment is
 * content. (Our own `<!-- choir:source -->` marker is added downstream, long
 * after this.)
 */
function removeComments(container: Element, doc: Document): void {
  // SHOW_COMMENT is 128; jsdom's NodeFilter is on the window, which this module
  // does not hold, so the constant is spelled out.
  const walker = doc.createTreeWalker(container, 128);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
}

/** Replaces an element with its own children, keeping the text and inline markup. */
function unwrap(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

/**
 * Takes out the anchors that only make sense in a browser.
 *
 * Documentation sites hang a permalink on every heading — GitHub as an icon-only
 * `<a class="anchor">` beside the heading, MDN as an `<a href="#id">` wrapped
 * around the heading text, MIT as an anchor with an empty `href`. Converted
 * literally they become `[](#installation)` lines, headings that are links to
 * themselves, and `[Title]()`. None of them lead anywhere in a markdown file.
 */
function unwrapDeadAnchors(container: Element): void {
  for (const anchor of Array.from(container.querySelectorAll('a'))) {
    const href = (anchor.getAttribute('href') || '').trim();
    // A link to a fragment of the page we are converting, or to nothing at all.
    if (href !== '' && !href.startsWith('#')) continue;

    const hasText = Boolean(anchor.textContent?.trim());
    if (!hasText) {
      // Icon-only: an octicon `<svg>`, or nothing. An `<img>` is content, so it
      // is kept and only the dead link around it goes.
      if (!anchor.querySelector('img') || anchor.closest(HEADING_SELECTOR)) anchor.remove();
      else unwrap(anchor);
      continue;
    }

    // A self-link keeps its words: always when the href is empty (it is not a
    // link at all), and inside a heading, where it is the permalink. Elsewhere a
    // fragment link may be a real cross-reference, so it stays.
    if (href === '' || anchor.closest(HEADING_SELECTOR)) unwrap(anchor);
  }
}

function rewriteLinks(container: Element, baseUrl: string, doc: Document): void {
  for (const anchor of Array.from(container.querySelectorAll('a[href]'))) {
    const href = (anchor.getAttribute('href') || '').trim();

    // `javascript:` links do nothing in a markdown file and would be a live
    // target if the document were ever rendered elsewhere. Keep the words, drop
    // the link.
    if (/^javascript:/i.test(href)) {
      anchor.replaceWith(doc.createTextNode(anchor.textContent || ''));
      continue;
    }
    if (!href || isNonNavigationalHref(href)) continue;

    const absolute = absolutize(href, baseUrl);
    if (absolute) anchor.setAttribute('href', absolute);
    else anchor.removeAttribute('href');
  }
}

function rewriteImages(container: Element, baseUrl: string): void {
  for (const image of Array.from(container.querySelectorAll('img'))) {
    let src = (image.getAttribute('src') || '').trim();
    if (!src) {
      const srcset = (image.getAttribute('srcset') || image.getAttribute('data-srcset') || '').trim();
      src = srcset ? (firstSrcsetCandidate(srcset) ?? '') : '';
    }
    image.removeAttribute('srcset');

    if (!src) {
      image.remove();
      continue;
    }

    // Inline images stay inline: collect-images decodes the payload, so the URL
    // is carried through as-is rather than resolved against the page.
    if (/^data:/i.test(src)) {
      if (/^data:image\//i.test(src)) image.setAttribute('src', src);
      else image.remove();
      continue;
    }

    const absolute = absolutize(src, baseUrl);
    if (absolute) image.setAttribute('src', absolute);
    else image.remove();
  }
}

/**
 * Gives a header row to tables written without one.
 *
 * GFM has no way to spell a table whose first row is data, so the converter
 * emits an empty header above it. Promoting the first row instead keeps the
 * table readable — a page that writes `<td>Symptom</td>` in row one meant it as
 * a header even though it never said so.
 */
function promoteHeaderlessTables(container: Element, doc: Document): void {
  for (const table of Array.from(container.querySelectorAll('table'))) {
    if (table.querySelector('thead') || table.querySelector('th')) continue;

    const firstRow = table.querySelector('tr');
    if (!firstRow) continue;

    for (const cell of Array.from(firstRow.querySelectorAll('td'))) {
      const header = doc.createElement('th');
      header.innerHTML = cell.innerHTML;
      cell.replaceWith(header);
    }

    const head = doc.createElement('thead');
    head.appendChild(firstRow);
    table.insertBefore(head, table.firstChild);
  }
}

/**
 * Language names we accept when a page names one without a prefix — MDN's
 * `class="brush: js"` and `<pre class="js">`. An allowlist, because a bare class
 * is usually styling: guessing from any unknown token would label a code block
 * `notranslate`.
 */
const KNOWN_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'graphql',
  'groovy',
  'haskell',
  'html',
  'ini',
  'java',
  'javascript',
  'js',
  'json',
  'jsx',
  'kotlin',
  'latex',
  'less',
  'lua',
  'makefile',
  'markdown',
  'md',
  'nginx',
  'objectivec',
  'perl',
  'php',
  'powershell',
  'python',
  'r',
  'rb',
  'ruby',
  'rust',
  'scala',
  'scss',
  'sh',
  'shell',
  'sql',
  'svelte',
  'swift',
  'toml',
  'ts',
  'tsx',
  'typescript',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

/** `language-ts`, `lang-ts`, GitHub's `highlight-source-ts`, Prism's `brush-ts`. */
const PREFIXED_LANGUAGE = /^(?:language|lang|highlight-source|brush)[-:](.+)$/;

function languageFromClasses(classes: string[], acceptBareName: boolean): string | null {
  for (const raw of classes) {
    const prefixed = raw.toLowerCase().match(PREFIXED_LANGUAGE);
    if (prefixed?.[1]) return prefixed[1];
  }
  if (!acceptBareName) return null;

  for (const raw of classes) {
    // `class="brush: js"` reaches the DOM as the two classes `brush:` and `js`.
    const name = raw.toLowerCase().replace(/[:;,]+$/, '');
    if (KNOWN_LANGUAGES.has(name)) return name;
  }
  return null;
}

/**
 * Normalizes the many ways a page marks up a code block's language into the one
 * hast-util-to-mdast reads: `class="language-x"` on a `<code>` inside the `<pre>`.
 *
 * Real pages put it anywhere: MDN on the `<pre>` (`brush: css`), GitHub on the
 * wrapping `<div class="highlight highlight-source-js">` around a `<pre>` that
 * has no `<code>` at all. Both were losing their fence language in the spike, so
 * the search walks outward and the `<code>` is created when it is missing.
 */
function normalizeCodeLanguages(container: Element, doc: Document): void {
  for (const pre of Array.from(container.querySelectorAll('pre'))) {
    let code = pre.querySelector('code');

    // The element's own classes may name the language bare; a wrapper's must be
    // prefixed, since a wrapper is styled for a dozen other reasons.
    let language =
      languageFromClasses(code ? Array.from(code.classList) : [], true) ??
      languageFromClasses(Array.from(pre.classList), true);

    let wrapper = pre.parentElement;
    for (let depth = 0; !language && wrapper && depth < 3 && wrapper !== container; depth += 1) {
      language = languageFromClasses(Array.from(wrapper.classList), false);
      wrapper = wrapper.parentElement;
    }
    if (!language) continue;

    if (!code) {
      code = doc.createElement('code');
      while (pre.firstChild) code.appendChild(pre.firstChild);
      pre.appendChild(code);
    }
    code.classList.add(`language-${language}`);
  }
}

/** Block-level tags that a table cell cannot keep once the table becomes GFM. */
const BLOCK_IN_CELL = new Set([
  'P',
  'DIV',
  'UL',
  'OL',
  'DL',
  'LI',
  'DT',
  'DD',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
  'SECTION',
  'ARTICLE',
  'FIGURE',
  'FIGCAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * What a block boundary becomes inside a flattened cell.
 *
 * Not `<br>`: rehype-remark turns that into an mdast `break`, which
 * remark-stringify renders as a plain space inside a table row — the list items
 * would run into each other with nothing between them. A visible separator
 * survives the round trip and still reads as "these were separate things".
 */
const CELL_BLOCK_SEPARATOR = '·';

/**
 * Flattens a cell's block content to inline HTML, block boundaries becoming a
 * separator.
 *
 * A GFM table row is one line, so a list inside a `<td>` — MDN's "Permitted
 * content" row — spills across a dozen lines and ends the table for every
 * markdown parser after it. Inline markup (links, code, emphasis) is kept whole;
 * only the block structure is given up, and a table that survives is worth more
 * than a list that does not.
 */
function cellToInlineHtml(cell: Element): string {
  const parts: string[] = [];

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = (child.textContent || '').replace(/\s+/g, ' ');
        if (text.trim()) parts.push(escapeHtmlText(text.trim()));
        continue;
      }
      if (child.nodeType !== 1) continue;

      const element = child as Element;
      if (element.tagName === 'BR') {
        parts.push(CELL_BLOCK_SEPARATOR);
      } else if (BLOCK_IN_CELL.has(element.tagName)) {
        parts.push(CELL_BLOCK_SEPARATOR);
        walk(element);
        parts.push(CELL_BLOCK_SEPARATOR);
      } else {
        parts.push(element.outerHTML);
      }
    }
  };
  walk(cell);

  const separators = new RegExp(`(?:\\s*${CELL_BLOCK_SEPARATOR}\\s*)+`, 'g');
  return parts
    .join(' ')
    .replace(separators, ` ${CELL_BLOCK_SEPARATOR} `)
    .replace(new RegExp(`^\\s*${CELL_BLOCK_SEPARATOR}\\s*|\\s*${CELL_BLOCK_SEPARATOR}\\s*$`, 'g'), '')
    .trim();
}

/** The same tags as a selector, for finding the cells that need flattening. */
const BLOCK_IN_CELL_SELECTOR =
  'p, div, ul, ol, dl, dt, dd, pre, blockquote, table, section, article, figure, h1, h2, h3, h4, h5, h6';

function flattenTableCells(container: Element): void {
  for (const cell of Array.from(container.querySelectorAll('td, th'))) {
    if (!cell.querySelector(BLOCK_IN_CELL_SELECTOR)) continue;
    cell.innerHTML = cellToInlineHtml(cell);
  }
}

function firstNonEmpty(candidates: Array<string | null | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    const trimmed = (candidate || '').trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || 'Untitled';
  } catch {
    return 'Untitled';
  }
}

/** How many characters of running text an element holds. */
function textLengthOf(element: Element): number {
  return (element.textContent || '').replace(/\s+/g, ' ').trim().length;
}

/** True when the element holds something worth converting (text or an image). */
function hasContent(element: Element): boolean {
  return textLengthOf(element) > 0 || Boolean(element.querySelector('img'));
}

function fallbackHtml(document: Document): string {
  const root = document.querySelector('main') ?? document.querySelector('article') ?? document.body;
  if (!root) return '';

  // Work on a copy: the original document still has to answer for its title.
  const clone = root.cloneNode(true) as Element;
  for (const node of Array.from(clone.querySelectorAll(FURNITURE_SELECTOR))) node.remove();
  return clone.innerHTML;
}

/** Collapses the blank-line noise a converted page tends to carry. */
function tidy(markdown: string): string {
  return markdown
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether the document already has a top-level heading, ignoring code fences. */
function hasTopLevelHeading(markdown: string): boolean {
  const withoutFences = markdown.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, '');
  return /^# \S/m.test(withoutFences);
}

function toMarkdown(html: string): string {
  const file = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: '-',
      emphasis: '_',
      strong: '*',
      fences: true,
      rule: '-',
      listItemIndent: 'one',
    })
    .processSync(html);
  return String(file);
}

export function htmlToMarkdown(html: string, baseUrl: string): HtmlToMarkdownResult {
  // A bare VirtualConsole (no listeners) silences jsdom's parse warnings; jsdom
  // runs no scripts and loads no subresources by default, which is what makes it
  // safe to point at an arbitrary public page.
  const parse = () => new JSDOM(html, { url: baseUrl, virtualConsole: new VirtualConsole() }).window.document;
  const document = parse();

  // Readability rewrites the document it is given, so everything the original is
  // still needed for is read first.
  const openGraphTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const documentTitle = document.title;

  // `keepClasses` because a code block's language lives in `class="language-x"`;
  // Readability's default strips every class and takes the language with it.
  const article = new Readability(document, { keepClasses: true }).parse();
  const title = firstNonEmpty([article?.title, openGraphTitle, documentTitle], hostnameOf(baseUrl));

  let container = document.createElement('div');
  container.innerHTML = article?.content || '';

  // Unwrap Readability's own `<div id="readability-page-1" class="page">`.
  const wrapper = container.querySelector(`#${READABILITY_WRAPPER_ID}`);
  if (wrapper) container.innerHTML = wrapper.innerHTML;

  let usedFallback = false;
  const articleChars = textLengthOf(container);
  if (articleChars < MIN_ARTICLE_CHARS) {
    // Readability consumed the first parse, so the page is read again — only on
    // this path, which is the rare one.
    const fallback = document.createElement('div');
    fallback.innerHTML = fallbackHtml(parse());

    // Only if the body adds real text. A genuinely short page keeps its clean
    // article: trading it for the whole body over the few characters Readability
    // trimmed would be a worse document, not a longer one.
    const saysMore = textLengthOf(fallback) - articleChars >= MIN_ARTICLE_CHARS / 2;
    if (saysMore || (!hasContent(container) && hasContent(fallback))) {
      container = fallback;
      usedFallback = true;
    }
  }

  const removeSelector = usedFallback ? FURNITURE_SELECTOR : ALWAYS_REMOVED_SELECTOR;
  for (const node of Array.from(container.querySelectorAll(removeSelector))) node.remove();

  removeComments(container, document);
  unwrapDeadAnchors(container);
  rewriteLinks(container, baseUrl, document);
  rewriteImages(container, baseUrl);
  normalizeCodeLanguages(container, document);
  promoteHeaderlessTables(container, document);
  flattenTableCells(container);

  let markdown = tidy(toMarkdown(container.innerHTML));
  if (markdown && !hasTopLevelHeading(markdown)) {
    markdown = `# ${title}\n\n${markdown}`;
  } else if (!markdown) {
    markdown = `# ${title}`;
  }

  return { markdown, title, imageUrls: extractImageUrls(markdown), usedFallback };
}
