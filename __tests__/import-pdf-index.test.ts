/** See import-pdf-inspect.test.ts for why pdfjs is reached through the real Node require. */
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const getBuiltinModule = (process as unknown as { getBuiltinModule(id: string): typeof import('node:module') })
    .getBuiltinModule;
  return getBuiltinModule('module').createRequire(__filename)('pdfjs-dist/legacy/build/pdf.mjs');
});

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEFAULT_PDF_IMPORT_CONFIG, type PdfImportConfig } from 'services/import/sources/pdf/config';
import { convertPdf } from 'services/import/sources/pdf/index';
import type { PdfLlmClient } from 'services/import/sources/pdf/llm-convert';
import type { ImportProgressEvent } from 'services/import/types';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const BODY = [
  'The retention period for onboarding records is three years.',
  'Managers may request an extension in writing before it ends.',
  'Every request is recorded in the shared register by the owner.',
];

/** The markdown a well-behaved transcription of BODY would produce. */
const FAITHFUL = `# Employee Handbook\n\n${BODY.join('\n\n')}`;

/**
 * A three-page document in a corporate template: every page repeats a header and
 * carries a page number, and each page's body is different.
 */
const TEMPLATE_BODY = [
  'The register records every request and the date it was approved.',
  'Managers keep the signed copy for as long as the policy requires.',
  'An extension must be requested in writing before the period ends.',
];

async function buildTemplatePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText('CONFIDENTIAL — Internal Draft', { x: 50, y: 800, size: 9, font });
    page.drawText('Employee Handbook', { x: 50, y: 760, size: 22, font });
    page.drawText(TEMPLATE_BODY[pageNumber - 1], { x: 50, y: 720, size: 11, font });
    page.drawText(`Page ${pageNumber} of 3`, { x: 50, y: 40, size: 9, font });
  }
  return Buffer.from(await doc.save());
}

async function buildPdf(
  options: { pages?: number; title?: string; scannedPages?: number[]; vectorPages?: number[] } = {},
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  if (options.title) doc.setTitle(options.title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(TINY_PNG);

  const pages = options.pages ?? 1;
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = doc.addPage([595, 842]);
    if (options.scannedPages?.includes(pageNumber)) {
      page.drawImage(png, { x: 100, y: 400, width: 200, height: 200 });
      continue;
    }
    if (options.vectorPages?.includes(pageNumber)) {
      page.drawRectangle({ x: 100, y: 400, width: 200, height: 120 });
      continue;
    }
    let y = 780;
    page.drawText('Employee Handbook', { x: 50, y, size: 22, font });
    y -= 44;
    for (const line of BODY) {
      page.drawText(line, { x: 50, y, size: 11, font });
      y -= 18;
    }
  }
  return Buffer.from(await doc.save());
}

function config(overrides: Partial<PdfImportConfig> = {}): PdfImportConfig {
  return { ...DEFAULT_PDF_IMPORT_CONFIG, textPageMinChars: 20, ...overrides };
}

function client(answers: string[]): PdfLlmClient {
  let call = 0;
  return {
    responses: {
      create: async () => {
        const output_text = answers[call] ?? answers[answers.length - 1];
        call += 1;
        return { output_text, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
    post: async () => ({ input_tokens: 10 }),
  };
}

function failingClient(message: string): PdfLlmClient {
  return {
    responses: {
      create: async () => {
        throw new Error(message);
      },
    },
    post: async () => ({ input_tokens: 0 }),
  };
}

describe('convertPdf', () => {
  it('produces a ConvertedDocument with no assets and a pdf source', async () => {
    const bytes = await buildPdf({ title: 'Employee Handbook 2026' });

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client([FAITHFUL]),
      model: 'gpt-5.4-mini',
    });

    expect(converted.markdown.startsWith('# Employee Handbook\n')).toBe(true);
    expect(converted.title).toBe('Employee Handbook 2026');
    expect(converted.assets).toEqual([]);
    expect(converted.rejectedAssets).toEqual([]);
    expect(converted.warnings).toEqual([]);
    expect(converted.source).toEqual({ kind: 'pdf', name: 'handbook.pdf', pages: 1 });
  });

  it('walks checking → converting → ready and survives a listener that throws', async () => {
    const bytes = await buildPdf();
    const steps: ImportProgressEvent['step'][] = [];

    await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      onProgress: (event) => {
        steps.push(event.step);
        throw new Error('the listener exploded');
      },
      client: client([FAITHFUL]),
      model: 'gpt-5.4-mini',
    });

    expect(steps[0]).toBe('checking');
    expect(steps).toContain('converting');
    expect(steps[steps.length - 1]).toBe('ready');
  });

  it('falls back to the filename when the PDF has no title and the markdown has no heading', async () => {
    const bytes = await buildPdf();

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'staff-handbook.pdf',
      config: config({ fidelityThreshold: 0 }),
      client: client(['Just a paragraph with no heading at all.']),
      model: 'gpt-5.4-mini',
    });

    expect(converted.title).toBe('staff-handbook');
    expect(converted.markdown.startsWith('# staff-handbook\n\nJust a paragraph')).toBe(true);
  });

  it("takes the title from the markdown's own heading when the PDF has no metadata title", async () => {
    const bytes = await buildPdf();

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client([FAITHFUL]),
      model: 'gpt-5.4-mini',
    });

    expect(converted.title).toBe('Employee Handbook');
  });

  it('warns when the transcription drops most of the extracted text', async () => {
    const bytes = await buildPdf();

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client(['# Employee Handbook\n\nRecords are kept for a while.']),
      model: 'gpt-5.4-mini',
    });

    const warning = converted.warnings.find((item) => item.code === 'low_fidelity');
    expect(warning).toBeDefined();
    expect(Number(warning?.detail?.score)).toBeLessThan(0.85);
  });

  it('warns about scanned pages and skips the fidelity check on them', async () => {
    const bytes = await buildPdf({ pages: 2, scannedPages: [2] });

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client([FAITHFUL, '## Scanned section\n\nSomething only the image shows.']),
      model: 'gpt-5.4-mini',
    });

    expect(converted.warnings).toContainEqual({ code: 'scanned_pages', detail: { count: 1 } });
    expect(converted.warnings.some((warning) => warning.code === 'low_fidelity')).toBe(false);
  });

  it('falls back to the text layer when the model fails, and says so', async () => {
    const bytes = await buildPdf();

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: failingClient('upstream is down'),
      model: 'gpt-5.4-mini',
    });

    expect(converted.warnings).toContainEqual({ code: 'low_fidelity', detail: { reason: 'llm_failed' } });
    expect(converted.markdown).toContain('# Employee Handbook');
    expect(converted.markdown).toContain('The retention period for onboarding records is three years.');
  });

  it('does not hide a failure when the manager asked for the model specifically', async () => {
    const bytes = await buildPdf();

    await expect(
      convertPdf({
        workspaceId: 'W1',
        bytes,
        filename: 'handbook.pdf',
        config: config({ mode: 'llm' }),
        client: failingClient('upstream is down'),
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toThrow('upstream is down');
  });

  it('never calls the model in text mode', async () => {
    const bytes = await buildPdf();

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config({ mode: 'text' }),
      client: failingClient('the model must not be called'),
      model: 'gpt-5.4-mini',
    });

    expect(converted.markdown).toContain('# Employee Handbook');
    expect(converted.warnings).toEqual([]);
  });

  it('refuses a scanned PDF in text mode, where there is nothing to read it with', async () => {
    const bytes = await buildPdf({ pages: 1, scannedPages: [1] });

    await expect(
      convertPdf({
        workspaceId: 'W1',
        bytes,
        filename: 'scan.pdf',
        config: config({ mode: 'text' }),
        client: failingClient('the model must not be called'),
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toMatchObject({ name: 'ImportRefusal', status: 422, code: 'import_pdf_no_text' });
  });

  it('does not cry wolf when the model correctly dropped the running header and page numbers', async () => {
    const bytes = await buildTemplatePdf();
    // Exactly what the prompt asks for: the body, no header, no page numbers.
    const faithful = `# Employee Handbook\n\n${TEMPLATE_BODY.join('\n\n')}`;

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client([faithful]),
      model: 'gpt-5.4-mini',
    });

    expect(converted.warnings).toEqual([]);
  });

  it('still warns when real content is missing from a templated document', async () => {
    const bytes = await buildTemplatePdf();
    const summarised = '# Employee Handbook\n\nRecords are kept for a while.';

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client([summarised]),
      model: 'gpt-5.4-mini',
    });

    const warning = converted.warnings.find((item) => item.code === 'low_fidelity');
    expect(warning).toBeDefined();
    expect(Number(warning?.detail?.score)).toBeLessThan(0.85);
  });

  it('refuses a vector-only document in every mode, without paying for a call', async () => {
    const bytes = await buildPdf({ pages: 2, vectorPages: [1, 2] });

    for (const mode of ['auto', 'llm', 'text'] as const) {
      await expect(
        convertPdf({
          workspaceId: 'W1',
          bytes,
          filename: 'diagram.pdf',
          config: config({ mode }),
          client: failingClient('the model must not be called'),
          model: 'gpt-5.4-mini',
        }),
      ).rejects.toMatchObject({ name: 'ImportRefusal', status: 422, code: 'import_pdf_no_text' });
    }
  });

  it('converts a document that merely contains a blank page', async () => {
    const bytes = await buildPdf({ pages: 3, vectorPages: [2] });

    const converted = await convertPdf({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      config: config(),
      client: client([FAITHFUL]),
      model: 'gpt-5.4-mini',
    });

    expect(converted.source).toEqual({ kind: 'pdf', name: 'handbook.pdf', pages: 3 });
    // A blank page is not a scan, so it raises no warning and no `detail: high`.
    expect(converted.warnings).toEqual([]);
  });

  it('passes a gate refusal straight through', async () => {
    await expect(
      convertPdf({
        workspaceId: 'W1',
        bytes: Buffer.from('not a pdf at all'),
        filename: 'notes.txt',
        config: config(),
        client: client([FAITHFUL]),
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toMatchObject({ name: 'ImportRefusal', status: 415, code: 'import_unsupported_file' });
  });
});
