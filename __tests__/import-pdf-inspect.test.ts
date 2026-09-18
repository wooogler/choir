/**
 * pdfjs-dist 6 ships as ESM only and its `pdf.mjs` uses `import.meta`, which
 * jest's CommonJS runtime cannot evaluate — adding it to `transformIgnorePatterns`
 * does not help, because ts-jest leaves `import.meta` in place. Node 22 *can*
 * `require()` an ES module, so the mock hands the module back through the real
 * Node require, reached via `process.getBuiltinModule` (jest intercepts
 * `require('node:module')`, but not that). The module under test is untouched.
 */
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const getBuiltinModule = (process as unknown as { getBuiltinModule(id: string): typeof import('node:module') })
    .getBuiltinModule;
  return getBuiltinModule('module').createRequire(__filename)('pdfjs-dist/legacy/build/pdf.mjs');
});

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEFAULT_PDF_IMPORT_CONFIG, type PdfImportConfig } from 'services/import/sources/pdf/config';
import { buildLines, inspectPdf } from 'services/import/sources/pdf/inspect';
import { ImportRefusal } from 'services/import/types';

/** 1×1 transparent PNG — enough to make a page that carries an image and no text. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface DrawnLine {
  text: string;
  size?: number;
}

async function buildPdf(pages: Array<DrawnLine[] | 'image' | 'vector' | 'empty'>, title?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(TINY_PNG);

  for (const spec of pages) {
    const page = doc.addPage([595, 842]);
    if (spec === 'image') {
      page.drawImage(png, { x: 100, y: 400, width: 200, height: 200 });
      continue;
    }
    if (spec === 'vector') {
      // A drawing with no text layer and no raster: invisible to the pipeline.
      page.drawRectangle({ x: 100, y: 400, width: 200, height: 120 });
      page.drawLine({ start: { x: 100, y: 400 }, end: { x: 300, y: 520 } });
      continue;
    }
    if (spec === 'empty') continue;
    let y = 780;
    for (const line of spec) {
      const size = line.size ?? 11;
      page.drawText(line.text, { x: 50, y, size, font });
      y -= size * 1.6;
    }
  }
  return Buffer.from(await doc.save());
}

function config(overrides: Partial<PdfImportConfig> = {}): PdfImportConfig {
  return { ...DEFAULT_PDF_IMPORT_CONFIG, textPageMinChars: 20, ...overrides };
}

const BODY = [
  'The retention period for onboarding records is three years.',
  'Managers may request an extension in writing before it ends.',
  'Every request is recorded in the shared register.',
];

describe('buildLines', () => {
  it('groups items on the same baseline and orders them left to right', () => {
    const lines = buildLines([
      { str: 'world', transform: [10, 0, 0, 10, 140, 700], width: 40, height: 10 },
      { str: 'Hello', transform: [10, 0, 0, 10, 100, 700], width: 35, height: 10 },
      { str: 'Second line', transform: [10, 0, 0, 10, 100, 680], width: 60, height: 10 },
    ]);

    expect(lines.map((line) => line.text)).toEqual(['Hello world', 'Second line']);
    expect(lines[0].y).toBe(700);
    expect(lines[0].height).toBe(10);
  });

  it('keeps the tallest item height for the line', () => {
    const lines = buildLines([
      { str: 'Big', transform: [24, 0, 0, 24, 100, 700], width: 40, height: 24 },
      { str: 'small', transform: [10, 0, 0, 10, 145, 700.5], width: 25, height: 10 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].height).toBe(24);
  });

  it('ignores marked-content markers and blank runs', () => {
    const lines = buildLines([
      { type: 'beginMarkedContent', tag: 'Artifact' },
      { str: '   ', transform: [10, 0, 0, 10, 100, 700], width: 5, height: 10 },
      { str: 'Real text', transform: [10, 0, 0, 10, 100, 700], width: 50, height: 10 },
    ]);
    expect(lines.map((line) => line.text)).toEqual(['Real text']);
  });

  it('returns nothing for a page with no text items', () => {
    expect(buildLines([])).toEqual([]);
  });
});

describe('inspectPdf', () => {
  it('reads page count, metadata title and per-page text', async () => {
    const bytes = await buildPdf(
      [[{ text: 'Employee Handbook', size: 22 }, ...BODY.map((text) => ({ text }))], BODY.map((text) => ({ text }))],
      'Employee Handbook 2026',
    );

    const inspection = await inspectPdf(bytes, config());

    expect(inspection.pages).toBe(2);
    expect(inspection.title).toBe('Employee Handbook 2026');
    expect(inspection.pageTexts).toHaveLength(2);
    expect(inspection.pageTexts[0]).toContain('Employee Handbook');
    expect(inspection.pageTexts[0]).toContain('The retention period for onboarding records is three years.');
    expect(inspection.textPages).toEqual([1, 2]);
    expect(inspection.scannedPages).toEqual([]);
  });

  it('keeps the heading taller than the body in the line geometry', async () => {
    const bytes = await buildPdf([[{ text: 'Employee Handbook', size: 22 }, ...BODY.map((text) => ({ text }))]]);
    const inspection = await inspectPdf(bytes, config());

    const [heading, ...body] = inspection.pageLines[0];
    expect(heading.text).toBe('Employee Handbook');
    expect(heading.height).toBeGreaterThan(body[0].height * 1.7);
    // y decreases down the page.
    expect(heading.y).toBeGreaterThan(body[0].y);
  });

  it('counts a page with an image and no text layer as scanned', async () => {
    const bytes = await buildPdf([BODY.map((text) => ({ text })), 'image', BODY.map((text) => ({ text }))]);
    const inspection = await inspectPdf(bytes, config());

    expect(inspection.textPages).toEqual([1, 3]);
    expect(inspection.scannedPages).toEqual([2]);
    expect(inspection.imagePages).toEqual([2]);
    expect(inspection.blankPages).toEqual([]);
    expect(inspection.pageTexts[1]).toBe('');
  });

  it('counts a thin text layer with no image behind it as blank, not scanned', async () => {
    const bytes = await buildPdf([[{ text: 'ok' }], BODY.map((text) => ({ text }))]);
    const inspection = await inspectPdf(bytes, config({ textPageMinChars: 50 }));

    expect(inspection.scannedPages).toEqual([]);
    expect(inspection.blankPages).toEqual([1]);
    expect(inspection.textPages).toEqual([2]);
  });

  it('counts a thin text layer over an image as scanned', async () => {
    // What a scan with a bad OCR layer looks like: a few characters and a page image.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const png = await doc.embedPng(TINY_PNG);
    const first = doc.addPage([595, 842]);
    first.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
    first.drawText('ok', { x: 50, y: 780, size: 11, font });
    const second = doc.addPage([595, 842]);
    let y = 780;
    for (const text of BODY) {
      second.drawText(text, { x: 50, y, size: 11, font });
      y -= 18;
    }

    const inspection = await inspectPdf(Buffer.from(await doc.save()), config({ textPageMinChars: 50 }));
    expect(inspection.scannedPages).toEqual([1]);
    expect(inspection.blankPages).toEqual([]);
    expect(inspection.textPages).toEqual([2]);
  });

  it('separates a vector-only page from a scan: neither has text, only one can be read', async () => {
    const bytes = await buildPdf([BODY.map((text) => ({ text })), 'vector', 'image']);
    const inspection = await inspectPdf(bytes, config());

    expect(inspection.textPages).toEqual([1]);
    expect(inspection.blankPages).toEqual([2]);
    expect(inspection.scannedPages).toEqual([3]);
    expect(inspection.imagePages).toEqual([3]);
  });

  it('refuses a document whose every page is vector-only or empty, in any mode', async () => {
    await expect(inspectPdf(await buildPdf(['vector', 'empty']), config())).rejects.toMatchObject({
      name: 'ImportRefusal',
      status: 422,
      code: 'import_pdf_no_text',
    });
  });

  it('accepts a document with blank pages inside it', async () => {
    const bytes = await buildPdf([BODY.map((text) => ({ text })), 'empty', BODY.map((text) => ({ text }))]);
    const inspection = await inspectPdf(bytes, config());

    expect(inspection.blankPages).toEqual([2]);
    expect(inspection.textPages).toEqual([1, 3]);
  });

  it('lists a text page that also carries an image, without calling it scanned', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const png = await doc.embedPng(TINY_PNG);
    const page = doc.addPage([595, 842]);
    let y = 780;
    for (const text of BODY) {
      page.drawText(text, { x: 50, y, size: 11, font });
      y -= 18;
    }
    page.drawImage(png, { x: 100, y: 400, width: 200, height: 200 });

    const inspection = await inspectPdf(Buffer.from(await doc.save()), config());
    expect(inspection.textPages).toEqual([1]);
    expect(inspection.imagePages).toEqual([1]);
    expect(inspection.scannedPages).toEqual([]);
    expect(inspection.blankPages).toEqual([]);
  });

  it('leaves the caller’s buffer usable after inspection', async () => {
    const bytes = await buildPdf([BODY.map((text) => ({ text }))]);
    const before = bytes.length;
    await inspectPdf(bytes, config());
    expect(bytes.length).toBe(before);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('refuses a file that is not a PDF', async () => {
    await expect(inspectPdf(Buffer.from('<html><body>nope</body></html>'), config())).rejects.toMatchObject({
      name: 'ImportRefusal',
      status: 415,
      code: 'import_unsupported_file',
    });
  });

  it('refuses an empty upload', async () => {
    await expect(inspectPdf(Buffer.alloc(0), config())).rejects.toBeInstanceOf(ImportRefusal);
  });

  it('refuses a file over the byte limit, reporting the limit in MB', async () => {
    // The size check runs before parsing, so a plausible header and padding is
    // all a too-large upload needs to look like.
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5 * 1024 * 1024)]);
    await expect(inspectPdf(bytes, config({ maxBytes: 4 * 1024 * 1024 }))).rejects.toMatchObject({
      status: 413,
      code: 'import_too_large',
      detail: { maxMb: 4 },
    });
  });

  it('refuses a document over the page limit', async () => {
    const bytes = await buildPdf([[{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]]);
    await expect(inspectPdf(bytes, config({ maxPages: 2 }))).rejects.toMatchObject({
      status: 413,
      code: 'import_too_many_pages',
      detail: { pages: 3, max: 2 },
    });
  });
});
