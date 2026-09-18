import fs from 'node:fs';
import path from 'node:path';

/**
 * jsdom 29 reaches ESM-only packages that ship as `.mjs`, which ts-jest cannot
 * transpile to CommonJS (TypeScript always emits `.mjs` as ESM). Node 22 can
 * `require()` them, so jsdom is loaded through a real Node module object instead
 * of jest's registry. The module under test sees the genuine jsdom.
 */
jest.mock('jsdom', () => {
  const Module = require('node:module');
  const native = new Module('jsdom-native', null);
  native.paths = Module._nodeModulePaths(__dirname);
  return native.require('jsdom');
});

import { htmlToMarkdown } from 'services/import/sources/web/html-to-markdown';

const readFixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures/import-web', name), 'utf-8');

const ARTICLE_URL = 'https://example.com/docs/deploy';

describe('htmlToMarkdown: an article page', () => {
  const result = htmlToMarkdown(readFixture('article.html'), ARTICLE_URL);

  it('uses the article title and does not need the body fallback', () => {
    expect(result.title).toBe('Deployment handbook');
    expect(result.usedFallback).toBe(false);
  });

  it('keeps the heading levels the page used', () => {
    expect(result.markdown).toMatch(/^# Deployment handbook$/m);
    expect(result.markdown).toMatch(/^## Before you start$/m);
    expect(result.markdown).toMatch(/^### Configuration$/m);
  });

  it('keeps nested lists nested', () => {
    expect(result.markdown).toMatch(/^- Access to the cluster$/m);
    expect(result.markdown).toMatch(/^ {2,4}- Staging, for the rehearsal$/m);
  });

  it('writes tables as GFM, giving headerless tables a header row', () => {
    expect(result.markdown).toContain('| Stage   | Traffic | Hold       |');
    expect(result.markdown).toContain('| Canary  | 1%      | 15 minutes |');
    // The rollback table has no <thead>; its first row becomes the header rather
    // than sitting under an empty one.
    expect(result.markdown).toContain('| Symptom             | Action                            |');
    expect(result.markdown).not.toMatch(/^\|\s+\|\s+\|$/m);
  });

  it('fences code blocks with the language the page declared', () => {
    expect(result.markdown).toContain("```ts\nexport const config = {\n  region: 'ap-northeast-2',");
  });

  it('keeps inline code and blockquotes', () => {
    expect(result.markdown).toContain('`deploy rollback`');
    expect(result.markdown).toMatch(/^> Rolling back is not a failure\./m);
  });

  it('absolutizes relative links and leaves absolute ones alone', () => {
    expect(result.markdown).toContain('[configuration reference](https://example.com/docs/config)');
    expect(result.markdown).toContain('[status page](https://status.example.com/)');
  });

  it('drops javascript: links but keeps their words', () => {
    expect(result.markdown).not.toContain('javascript:');
    expect(result.markdown).toContain('Need help?');
  });

  it('absolutizes images and reads srcset when there is no src', () => {
    expect(result.markdown).toContain('![Rollout dashboard](https://example.com/img/rollout.png)');
    expect(result.markdown).toContain('![Latency by stage](https://example.com/img/latency-480.png)');
    expect(result.imageUrls).toEqual([
      'https://example.com/img/rollout.png',
      'https://example.com/img/latency-480.png',
    ]);
  });

  it('leaves the page furniture behind', () => {
    for (const furniture of ['Pricing', 'Example Corp engineering', 'Legal', 'Related', 'Enable JavaScript']) {
      expect(result.markdown).not.toContain(furniture);
    }
    expect(result.markdown).not.toContain('window.analytics');
    expect(result.markdown).not.toContain('font: 16px');
  });

  it('strips Readability’s own page wrapper', () => {
    expect(result.markdown).not.toContain('readability-page');
  });
});

describe('htmlToMarkdown: headings', () => {
  it('prepends the title when the page has no level-1 heading', () => {
    const result = htmlToMarkdown(readFixture('no-heading.html'), 'https://example.com/notes/2026-09/');

    expect(result.title).toBe('Release notes 2026.9 | Example Corp');
    expect(result.markdown.startsWith('# Release notes 2026.9 | Example Corp\n\n## What changed')).toBe(true);
  });

  it('resolves a relative image against the page directory', () => {
    const result = htmlToMarkdown(readFixture('no-heading.html'), 'https://example.com/notes/2026-09/');

    expect(result.imageUrls).toEqual(['https://example.com/notes/img/queue.png', 'https://cdn.example.com/badge.png']);
  });

  it('leaves the structure alone when a level-1 heading exists further down', () => {
    const html =
      '<html><head><title>Real title</title></head><body><div><img src="/a.png" alt="A"></div><h1>Real title</h1></body></html>';
    const result = htmlToMarkdown(html, ARTICLE_URL);

    expect(result.markdown.startsWith('![A]')).toBe(true);
    expect(result.markdown).toMatch(/^# Real title$/m);
    expect(result.markdown.match(/^# /gm)).toHaveLength(1);
  });
});

describe('htmlToMarkdown: the body fallback', () => {
  const result = htmlToMarkdown(readFixture('fallback.html'), 'https://status.example.com/');

  it('flags that Readability found no article', () => {
    expect(result.usedFallback).toBe(true);
  });

  it('falls back to og:title when there is no readable article title', () => {
    expect(result.title).toBe('Autumn release poster');
  });

  it('removes the furniture the fallback would otherwise carry', () => {
    expect(result.imageUrls).toEqual(['https://status.example.com/poster.png']);
    expect(result.markdown).not.toContain('logo.png');
    expect(result.markdown).not.toContain('wordmark.png');
    expect(result.markdown).not.toContain('document.querySelector');
  });
});

/**
 * The P0 spike (scripts/spike-import/RESULTS.md §3) ran a copy of this pipeline
 * over three live pages and found six defects. The fixtures below are those
 * pages, trimmed to a few KB, with their scripts removed and nothing else
 * changed — so each defect is pinned to the markup that actually produced it.
 */
describe('htmlToMarkdown: a GitHub README page', () => {
  const result = htmlToMarkdown(readFixture('github-readme.html'), 'https://github.com/mozilla/readability');

  it('starts the document with a level-1 heading, which the page itself lost', () => {
    // Readability demotes the README's own h1, so without the prepended title
    // the document would start at `##` — spike defect 6.
    expect(result.markdown.startsWith('# GitHub - mozilla/readability:')).toBe(true);
    expect(result.markdown).toMatch(/^## Installation$/m);
  });

  it('drops the icon-only permalink anchors beside each heading', () => {
    expect(result.markdown).not.toContain('[](#installation)');
    expect(result.markdown).not.toContain('[](#basic-usage)');
    expect(result.markdown).not.toMatch(/^\[]\(/m);
  });

  it('reads the fence language off the wrapper GitHub puts it on', () => {
    // `<div class="highlight highlight-source-js"><pre>` — with no <code> at all.
    expect(result.markdown).toContain('```js\nvar article = new Readability(document).parse();\n```');
    expect(result.markdown).toContain('```shell\nnpm install @mozilla/readability\n```');
  });

  it('keeps the repository prose and leaves the site chrome out', () => {
    expect(result.markdown).toContain('A standalone version of the readability library');
    expect(result.markdown).not.toContain('Pull requests');
    expect(result.markdown).not.toContain('GitHub, Inc.');
  });
});

describe('htmlToMarkdown: an MDN reference page', () => {
  const result = htmlToMarkdown(
    readFixture('mdn-table.html'),
    'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table',
  );

  it('strips the hydration comments the page is full of', () => {
    expect(result.markdown).not.toContain('<!--');
    expect(result.markdown).not.toContain('lit-node');
    expect(result.markdown).not.toContain('lit-part');
  });

  it('unwraps the anchor MDN wraps around each heading', () => {
    expect(result.markdown).toMatch(/^## Visual layout of table contents$/m);
    expect(result.markdown).toMatch(/^## Technical summary$/m);
    expect(result.markdown).not.toContain('](#technical_summary)');
  });

  it('keeps a table whose cell holds a list, flattening the cell to one line', () => {
    const rows = result.markdown.split('\n').filter((line) => line.startsWith('| '));
    const permitted = rows.find((row) => row.startsWith('| Permitted content'));

    // One row, one line: a list left as blocks would end the table here.
    expect(permitted).toBeDefined();
    expect(permitted).toContain('In this order: ·');
    expect(permitted).toContain('an optional [`<caption>`]');
    expect(permitted).toContain('an optional [`<tfoot>`]');
    // Every row of the table is still a row: header, rule, and six data rows.
    // (GFM has no header-less table, so the first row becomes the header.)
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain('Content categories');
    expect(rows[rows.length - 1]).toContain('DOM interface');
  });

  it('reads the fence language out of MDN’s `brush:` class', () => {
    expect(result.markdown).toContain('```css\ntable {\n  border-collapse: collapse;');
  });

  it('keeps the ordered and unordered lists outside the table', () => {
    expect(result.markdown).toMatch(/^1\. The row boxes fill the table/m);
    expect(result.markdown).toMatch(/^- \[`<caption>`]/m);
  });
});

describe('htmlToMarkdown: a page whose article is a list of links', () => {
  const result = htmlToMarkdown(
    readFixture('mit-index.html'),
    'https://policies.mit.edu/policies-procedures/110-privacy-and-disclosure-personal-information',
  );

  it('refuses an article too short to be one and uses the body instead', () => {
    // Readability returns 89 characters here: it scores a list of links as
    // navigation and keeps only the heading — spike defect 1.
    expect(result.usedFallback).toBe(true);
    expect(result.markdown.length).toBeGreaterThan(1000);
  });

  it('keeps the section index the page exists to show', () => {
    expect(result.markdown).toMatch(/^# 11\.0 Privacy and Disclosure of Personal Information$/m);
    // The page separates the number from the title with an em space.
    expect(result.markdown).toMatch(/\[11\.1\s+Protection of Personal Privacy]/);
    expect(result.markdown).toMatch(/\[11\.3\s+Privacy of Student Records]/);
    expect(result.markdown.match(/^ {2}- /gm)).toHaveLength(7);
  });
});

describe('htmlToMarkdown: a short article that is still an article', () => {
  it('keeps Readability’s answer when the page body says no more', () => {
    const html = `<html><head><title>Note</title></head><body><article>
      <h1>Note</h1><p>Short, but this is the whole page and the body holds nothing else.</p>
    </article></body></html>`;
    const result = htmlToMarkdown(html, 'https://example.com/note');

    expect(result.usedFallback).toBe(false);
    expect(result.markdown).toContain('Short, but this is the whole page');
  });
});

describe('htmlToMarkdown: image sources', () => {
  it('keeps data:image sources for the collector to decode', () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const result = htmlToMarkdown(`<body><p>Chart:</p><img src="${dataUri}" alt="Chart"></body>`, ARTICLE_URL);

    expect(result.imageUrls).toEqual([dataUri]);
  });

  it('drops images with no usable source, and non-image data URIs', () => {
    const html =
      '<body><p>Text.</p><img alt="no src"><img src="data:text/plain;base64,aGk=" alt="not an image"></body>';
    const result = htmlToMarkdown(html, ARTICLE_URL);

    expect(result.imageUrls).toEqual([]);
    expect(result.markdown).not.toContain('![');
  });

  it('reports each referenced image once, in order', () => {
    const html =
      '<body><p>One.</p><img src="/a.png" alt="A"><p>Two.</p><img src="/b.png" alt="B"><p>Again.</p><img src="/a.png" alt="A again"></body>';
    const result = htmlToMarkdown(html, ARTICLE_URL);

    expect(result.imageUrls).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
    expect(result.markdown.match(/!\[/g)).toHaveLength(3);
  });
});

describe('htmlToMarkdown: titles of last resort', () => {
  it('uses the document title, then the hostname', () => {
    const titled = htmlToMarkdown(
      '<html><head><title>Only a title</title></head><body><p>Hi.</p></body></html>',
      ARTICLE_URL,
    );
    expect(titled.title).toBe('Only a title');

    const untitled = htmlToMarkdown('<html><body><p>Hi.</p></body></html>', ARTICLE_URL);
    expect(untitled.title).toBe('example.com');
    expect(untitled.markdown).toBe('# example.com\n\nHi.');
  });
});
