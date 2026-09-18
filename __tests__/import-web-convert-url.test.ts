import type { ImportProgressEvent } from 'services/import/types';

/**
 * jsdom 29 reaches ESM-only packages that ship as `.mjs`, which ts-jest cannot
 * transpile to CommonJS. Node 22 can `require()` them, so jsdom is loaded through
 * a real Node module object instead of jest's registry.
 */
jest.mock('jsdom', () => {
  const Module = require('node:module');
  const native = new Module('jsdom-native', null);
  native.paths = Module._nodeModulePaths(__dirname);
  return native.require('jsdom');
});

import { decodeHtmlBody, fetchPage } from 'services/import/sources/web/fetch-page';
import { convertUrl } from 'services/import/sources/web/index';
import { ImportRefusal } from 'services/import/types';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PAGE = `<!doctype html>
<html><head><title>Runbook — Example Corp</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>Runbook</h1>
    <p>This runbook is what the on-call engineer reads at three in the morning, so it says what to do and
    nothing else. Every command below can be run from a laptop with the standard tooling installed, and none
    of them needs a second person to approve it. If a step does not work, stop and page the service owner
    rather than improvising; the improvisations are what turn a short incident into a long one.</p>
    <p>Keep the channel posted as you go, even when there is nothing to report: an incident where nobody
    said anything for twenty minutes reads, from the outside, exactly like an incident where nobody was
    looking. Write down what you tried and what it did, in the channel rather than in a notebook, so the
    person who takes over at the end of your shift does not start again from the beginning.</p>
    <h2>Dashboards</h2>
    <p><img src="/img/queue.png" alt="Queue depth"> <img src="/img/errors.png" alt="Error rate"></p>
  </article>
  <footer>© Example Corp</footer>
</body></html>`;

const page =
  (html: string, finalUrl = 'https://example.com/runbook') =>
  async () => ({
    html,
    finalUrl,
    contentType: 'text/html; charset=utf-8',
  });

describe('convertUrl', () => {
  it('turns a page into a document with its images attached', async () => {
    const steps: ImportProgressEvent[] = [];
    const result = await convertUrl('https://example.com/runbook', {
      fetchPage: page(PAGE),
      fetchImage: async () => ({ bytes: PNG, contentType: 'image/png' }),
      onProgress: (event) => steps.push(event),
    });

    expect(result.title).toBe('Runbook — Example Corp');
    expect(result.source).toEqual({ kind: 'url', name: 'Runbook — Example Corp', url: 'https://example.com/runbook' });
    expect(result.markdown).toMatch(/^# Runbook — Example Corp$/m);
    expect(result.markdown).not.toContain('© Example Corp');
    expect(result.warnings).toEqual([]);
    expect(result.rejectedAssets).toEqual([]);

    // Both images are the same bytes, so they share one content-addressed file.
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].path).toMatch(/^assets\/[0-9a-f]{40}\.png$/);
    expect(result.markdown).toContain(`![Queue depth](${result.assets[0].path})`);
    expect(result.markdown).toContain(`![Error rate](${result.assets[0].path})`);
    expect(result.markdown).not.toContain('https://example.com/img/');

    expect(steps.map((step) => step.step)).toEqual(['checking', 'fetching', 'converting', 'ready']);
    expect(steps.map((step) => step.label)).toEqual([
      'Checking the URL',
      'Fetching the page',
      'Converting to markdown',
      'Ready to review',
    ]);
  });

  it('reports dropped images and takes their references out of the markdown', async () => {
    const result = await convertUrl('https://example.com/runbook', {
      fetchPage: page(PAGE),
      fetchImage: async () => null,
    });

    expect(result.assets).toEqual([]);
    expect(result.rejectedAssets).toHaveLength(2);
    expect(result.warnings).toEqual([{ code: 'images_rejected', detail: { count: 2 } }]);
    expect(result.markdown).not.toContain('![');
    expect(result.markdown).toContain('Queue depth');
  });

  it('warns when the article had to be read off the page body', async () => {
    const html = `<html><head><title>Poster</title></head><body>
      <nav><a href="/"><img src="/img/logo.png" alt=""></a></nav>
      <div><img src="/img/poster.png" alt="Poster"></div>
    </body></html>`;
    const result = await convertUrl('https://example.com/poster', {
      fetchPage: page(html, 'https://example.com/poster'),
      fetchImage: async () => ({ bytes: PNG, contentType: 'image/png' }),
    });

    expect(result.warnings).toEqual([{ code: 'readability_fallback' }]);
    expect(result.assets).toHaveLength(1);
  });

  it('refuses a page that says nothing outside its heading', async () => {
    const html = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';

    await expect(convertUrl('https://example.com/app', { fetchPage: page(html) })).rejects.toMatchObject({
      name: 'ImportRefusal',
      status: 422,
      code: 'import_url_unreadable',
    });
  });

  it('passes a refusal from the fetch through untouched', async () => {
    const refusals = [
      new ImportRefusal(422, 'import_url_blocked', { status: 403 }),
      new ImportRefusal(422, 'import_url_unreadable', { status: 500 }),
      new ImportRefusal(415, 'import_unsupported_file', { contentType: 'application/pdf' }),
      new ImportRefusal(413, 'import_too_large'),
    ];

    for (const refusal of refusals) {
      const thrown = convertUrl('https://example.com/x', {
        fetchPage: async () => {
          throw refusal;
        },
      });
      await expect(thrown).rejects.toBe(refusal);
    }
  });

  it('lets an unexpected failure through for the route to call a conversion failure', async () => {
    const boom = new Error('socket hang up');
    const thrown = convertUrl('https://example.com/x', {
      fetchPage: async () => {
        throw boom;
      },
    });

    await expect(thrown).rejects.toBe(boom);
  });

  it('does not let a throwing progress listener break the import', async () => {
    const result = await convertUrl('https://example.com/runbook', {
      fetchPage: page(PAGE),
      fetchImage: async () => null,
      onProgress: () => {
        throw new Error('stream closed');
      },
    });

    expect(result.title).toBe('Runbook — Example Corp');
  });
});

describe('fetchPage', () => {
  it('refuses a string that is not a fetchable URL', async () => {
    for (const bad of ['not a url', 'ftp://example.com/x', 'file:///etc/passwd']) {
      await expect(fetchPage(bad)).rejects.toMatchObject({ status: 400, code: 'import_url_invalid' });
    }
  });

  it('refuses a URL that points at a non-public address', async () => {
    await expect(fetchPage('http://127.0.0.1/admin')).rejects.toMatchObject({
      status: 422,
      code: 'import_url_blocked',
    });
  });

  it('refuses a page that never answers, rather than calling it a conversion failure', async () => {
    // A literal public address so the SSRF guard resolves without a DNS query.
    const timeout = fetchPage('http://93.184.216.34/slow', {
      fetchImpl: async () => {
        const abort = new Error('This operation was aborted');
        abort.name = 'AbortError';
        throw abort;
      },
    });

    await expect(timeout).rejects.toMatchObject({
      name: 'ImportRefusal',
      status: 422,
      code: 'import_url_unreadable',
      detail: { reason: 'timeout' },
    });
  });

  it('refuses a host it cannot reach', async () => {
    const refused = fetchPage('http://93.184.216.34/down', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(refused).rejects.toMatchObject({
      status: 422,
      code: 'import_url_unreadable',
      detail: { reason: 'network' },
    });
  });
});

describe('decodeHtmlBody', () => {
  const latin1 = Buffer.from('<html><body><p>Caf\xe9 r\xe9sum\xe9</p></body></html>', 'latin1');

  it('honours a charset from the content-type header', () => {
    expect(decodeHtmlBody(latin1, 'text/html; charset=iso-8859-1')).toContain('Café résumé');
  });

  it('honours a charset the document declares about itself', () => {
    const withMeta = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>', 'latin1'),
      Buffer.from('Caf\xe9', 'latin1'),
      Buffer.from('</p></body></html>', 'latin1'),
    ]);

    expect(decodeHtmlBody(withMeta, 'text/html')).toContain('Café');
  });

  it('reads UTF-8 by default, and falls back to it for a charset it does not know', () => {
    const utf8 = Buffer.from('<p>안녕하세요</p>', 'utf-8');

    expect(decodeHtmlBody(utf8, 'text/html; charset=utf-8')).toContain('안녕하세요');
    expect(decodeHtmlBody(utf8, 'text/html')).toContain('안녕하세요');
    expect(decodeHtmlBody(utf8, 'text/html; charset=x-nonsense')).toContain('안녕하세요');
  });
});
