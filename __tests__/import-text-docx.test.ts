/**
 * jsdom 29 reaches ESM-only packages that ship as `.mjs`, which ts-jest cannot
 * transpile to CommonJS (TypeScript always emits `.mjs` as ESM). Node 22 can
 * `require()` them, so jsdom is loaded through a real Node module object instead
 * of jest's registry — the same shim `import-web-html-to-markdown.test.ts` uses.
 */
jest.mock('jsdom', () => {
  const Module = require('node:module');
  const native = new Module('jsdom-native', null);
  native.paths = Module._nodeModulePaths(__dirname);
  return native.require('jsdom');
});

/**
 * mammoth is mocked rather than fed a real `.docx`: building a valid Word zip in
 * a test would be testing the zip, and what this module actually does is the
 * glue — HTML to the repository's markdown flavour, images thrown away, and the
 * transcript detection run again on the words that come out.
 */
const convertToHtml = jest.fn();
jest.mock('mammoth', () => ({
  __esModule: true,
  default: { convertToHtml: (...args: unknown[]) => convertToHtml(...args) },
}));

import { loadTranscript } from 'services/import/sources/text';
import { docxToMarkdown } from 'services/import/sources/text/docx';

beforeEach(() => {
  convertToHtml.mockReset();
});

describe('docxToMarkdown', () => {
  it('turns the document into markdown and hands mammoth the buffer', async () => {
    convertToHtml.mockResolvedValue({
      value: '<h1>Weekly sync</h1><p>Sangwook Lee: Morning everyone.</p>',
      messages: [],
    });

    const bytes = Buffer.from('PK pretend this is a docx');
    const markdown = await docxToMarkdown(bytes);

    expect(convertToHtml).toHaveBeenCalledWith({ buffer: bytes });
    expect(markdown).toContain('# Weekly sync');
    expect(markdown).toContain('Sangwook Lee: Morning everyone.');
  });

  it('drops the base64 images mammoth inlines', async () => {
    convertToHtml.mockResolvedValue({
      value: '<p>Before</p><p><img src="data:image/png;base64,iVBORw0KGgo=" alt="screenshot"></p><p>After</p>',
      messages: [],
    });

    const markdown = await docxToMarkdown(Buffer.from('x'));

    expect(markdown).not.toContain('data:image');
    expect(markdown).not.toContain('base64');
    expect(markdown).toContain('Before');
    expect(markdown).toContain('After');
  });

  it('never leaves the placeholder base URL in the output', async () => {
    convertToHtml.mockResolvedValue({ value: '<p>Just words.</p>', messages: [] });
    expect(await docxToMarkdown(Buffer.from('x'))).not.toContain('file:///doc.docx');
  });
});

describe('loadTranscript with a .docx', () => {
  it('runs detection again on the words Word was hiding', async () => {
    convertToHtml.mockResolvedValue({
      value: [
        '<p>Sangwook Lee   0:03</p>',
        '<p>Morning everyone, let&rsquo;s get started.</p>',
        '<p>Minji Kim   0:31</p>',
        '<p>I pushed the retrieval change last night.</p>',
        '<p>Junho Park   1:02</p>',
        '<p>I still see the old answers in staging.</p>',
      ].join(''),
      messages: [],
    });

    const loaded = await loadTranscript({ filename: 'weekly.docx', bytes: Buffer.from('PK') });

    expect(loaded.kind).toBe('transcript-text');
    expect(loaded.stats.speakers).toEqual(['Sangwook Lee', 'Minji Kim', 'Junho Park']);
    // The markdown is kept so the preview can show what was actually read.
    expect(loaded.markdown).toContain('Minji Kim');
  });

  it('falls back to paragraphs when the document is just a document', async () => {
    convertToHtml.mockResolvedValue({
      value: '<h1>Retrieval notes</h1><p>We agreed to rebuild the index nightly.</p>',
      messages: [],
    });

    const loaded = await loadTranscript({ filename: 'notes.docx', bytes: Buffer.from('PK') });

    expect(loaded.kind).toBe('markdown');
    expect(loaded.stats.speakers).toEqual([]);
    expect(loaded.segments.length).toBeGreaterThan(0);
  });

  it('refuses a `.docx` that arrived with no bytes', async () => {
    await expect(loadTranscript({ filename: 'weekly.docx', text: 'pasted instead' })).rejects.toMatchObject({
      code: 'meeting_transcript_empty',
    });
  });
});
