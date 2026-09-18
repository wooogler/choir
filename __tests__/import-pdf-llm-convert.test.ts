import { PDFDocument, StandardFonts } from 'pdf-lib';
import { slicePdf } from 'services/import/sources/pdf/chunk';
import { DEFAULT_PDF_IMPORT_CONFIG, type PdfImportConfig } from 'services/import/sources/pdf/config';
import type { PdfInspection } from 'services/import/sources/pdf/inspect';
import {
  type PdfLlmClient,
  type PdfResponseRequest,
  convertPdfChunks,
  headingPathAtEnd,
  pdfFilename,
  stripCodeFence,
} from 'services/import/sources/pdf/llm-convert';
import type { PdfImportPlan } from 'services/import/sources/pdf/plan';
import type { ImportProgressEvent } from 'services/import/types';

async function buildPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) {
    doc.addPage([595, 842]).drawText(`Page ${page} of the source document.`, { x: 50, y: 780, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

function inspection(pages: number, title?: string): PdfInspection {
  const all = Array.from({ length: pages }, (_, index) => index + 1);
  return {
    pages,
    title,
    pageTexts: all.map((page) => `Page ${page} of the source document.`),
    pageLines: all.map(() => []),
    textPages: all,
    scannedPages: [],
    imagePages: [],
    blankPages: [],
  };
}

interface FakeClient extends PdfLlmClient {
  requests: PdfResponseRequest[];
}

function fakeClient(answers: string[]): FakeClient {
  const requests: PdfResponseRequest[] = [];
  return {
    requests,
    responses: {
      create: async (request) => {
        requests.push(request);
        return { output_text: answers[requests.length - 1] ?? '', usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
    post: async () => ({ input_tokens: 0 }),
  };
}

const PLAN_ONE: PdfImportPlan = { chunks: [{ from: 1, to: 2, detail: 'low' }], scannedPages: [] };
const PLAN_TWO: PdfImportPlan = {
  chunks: [
    { from: 1, to: 2, detail: 'low' },
    { from: 3, to: 4, detail: 'high' },
  ],
  scannedPages: [3, 4],
};

/** The chunk's prompt text, as it was actually sent. */
function promptOf(request: PdfResponseRequest): string {
  return (request.input[0] as { content: Array<Record<string, string>> }).content[0].text;
}

function config(overrides: Partial<PdfImportConfig> = {}): PdfImportConfig {
  return { ...DEFAULT_PDF_IMPORT_CONFIG, ...overrides };
}

describe('stripCodeFence', () => {
  it('unwraps a fence the model added around the whole answer', () => {
    expect(stripCodeFence('```markdown\n# Title\n\nBody\n```')).toBe('# Title\n\nBody');
    expect(stripCodeFence('```\n# Title\n```')).toBe('# Title');
    expect(stripCodeFence('~~~md\n# Title\n~~~')).toBe('# Title');
  });

  it('leaves a fence that is part of the document alone', () => {
    const markdown = '# Title\n\n```js\nconst x = 1;\n```\n\nAfter the code.';
    expect(stripCodeFence(markdown)).toBe(markdown);
  });
});

describe('headingPathAtEnd', () => {
  it('returns the heading stack still open at the end', () => {
    expect(headingPathAtEnd('# Handbook\n\n## Leave\n\n### Parental leave\n\nText.')).toEqual([
      'Handbook',
      'Leave',
      'Parental leave',
    ]);
  });

  it('pops siblings and deeper headings', () => {
    expect(headingPathAtEnd('# A\n\n## B\n\n### C\n\n## D\n\nText.')).toEqual(['A', 'D']);
  });

  it('ignores `#` inside a fenced code block', () => {
    expect(headingPathAtEnd('# A\n\n```sh\n# not a heading\n```\n\nText.')).toEqual(['A']);
  });

  it('is empty for markdown with no headings', () => {
    expect(headingPathAtEnd('Just a paragraph.')).toEqual([]);
  });
});

describe('pdfFilename', () => {
  it('makes sure the API sees a .pdf name', () => {
    expect(pdfFilename('handbook.pdf')).toBe('handbook.pdf');
    expect(pdfFilename('handbook')).toBe('handbook.pdf');
    expect(pdfFilename('  ')).toBe('document.pdf');
  });
});

describe('convertPdfChunks', () => {
  it('sends the prompt and the sliced PDF as one user message', async () => {
    const bytes = await buildPdf(2);
    const client = fakeClient(['# Handbook\n\nBody text.']);

    const result = await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(2, 'Employee Handbook'),
      plan: PLAN_ONE,
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    expect(result.markdown).toBe('# Handbook\n\nBody text.');
    expect(result.model).toBe('gpt-5.4-mini');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });

    const [request] = client.requests;
    expect(request.model).toBe('gpt-5.4-mini');
    expect(request.service_tier).toBe('flex');
    expect(request.max_output_tokens).toBeGreaterThanOrEqual(16000);
    // Transcription is not a reasoning task; the spike showed `low` is enough.
    expect(request.reasoning).toEqual({ effort: 'low' });

    const message = request.input[0] as { type: string; role: string; content: Array<Record<string, string>> };
    expect(message).toMatchObject({ type: 'message', role: 'user' });
    expect(message.content[0].type).toBe('input_text');
    expect(message.content[0].text).toContain('Transcribe');
    expect(message.content[0].text).toContain('do not summarize');
    expect(message.content[0].text).toContain('Employee Handbook');
    expect(message.content[1]).toMatchObject({ type: 'input_file', filename: 'handbook.pdf', detail: 'low' });
    expect(message.content[1].file_data.startsWith('data:application/pdf;base64,')).toBe(true);

    const attached = Buffer.from(message.content[1].file_data.split(',')[1], 'base64');
    expect(attached.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(attached.length).toBe((await slicePdf(bytes, 1, 2)).length);
  });

  it('routes each chunk at its own detail and carries the heading path forward', async () => {
    const bytes = await buildPdf(4);
    const client = fakeClient(['# Handbook\n\n## Leave\n\nFirst half.', 'More about leave.']);

    const result = await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(4),
      plan: PLAN_TWO,
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    expect(result.markdown).toBe('# Handbook\n\n## Leave\n\nFirst half.\n\nMore about leave.');
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });

    const detail = client.requests.map(
      (request) => (request.input[0] as { content: Array<Record<string, string>> }).content[1].detail,
    );
    expect(detail).toEqual(['low', 'high']);

    const secondPrompt = promptOf(client.requests[1]);
    expect(secondPrompt).toContain('"Handbook" > "Leave"');
    expect(secondPrompt).toContain('continuation');
    expect(secondPrompt).not.toContain('Begin the output with exactly one top-level title');
  });

  it('tells the model a scanned chunk is a scan, not an illustration', async () => {
    const bytes = await buildPdf(4);
    const client = fakeClient(['# Handbook', 'Transcribed from the scan.']);

    await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: { ...inspection(4), scannedPages: [3, 4], imagePages: [3, 4], textPages: [1, 2] },
      plan: PLAN_TWO,
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    // The text chunk keeps the plain rules; without this the spike's scanned
    // sample came back as a single `> [Figure: …]` line.
    expect(promptOf(client.requests[0])).not.toContain('scans');
    expect(promptOf(client.requests[1])).toContain('scans');
    expect(promptOf(client.requests[1])).toContain('transcribe it in full');
  });

  it('strips a code fence the model wrapped the answer in', async () => {
    const bytes = await buildPdf(2);
    const client = fakeClient(['```markdown\n# Handbook\n\nBody.\n```']);

    const result = await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(2),
      plan: PLAN_ONE,
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    expect(result.markdown).toBe('# Handbook\n\nBody.');
  });

  it('reports progress per chunk without letting a broken listener through', async () => {
    const bytes = await buildPdf(4);
    const client = fakeClient(['# A', 'B']);
    const events: ImportProgressEvent[] = [];

    const result = await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(4),
      plan: PLAN_TWO,
      config: config(),
      onProgress: (event) => {
        events.push(event);
        throw new Error('the listener exploded');
      },
      client,
      model: 'gpt-5.4-mini',
    });

    expect(result.markdown).toBe('# A\n\nB');
    expect(events).toEqual([
      { step: 'converting', label: expect.stringContaining('pp. 1–2'), current: 1, total: 2 },
      { step: 'converting', label: expect.stringContaining('pp. 3–4'), current: 2, total: 2 },
    ]);
  });

  it('retries once at the standard tier when flex has no capacity', async () => {
    const bytes = await buildPdf(2);
    const tiers: Array<string | undefined> = [];
    const client: PdfLlmClient = {
      responses: {
        create: async (request) => {
          tiers.push(request.service_tier);
          if (tiers.length === 1) {
            const error = Object.assign(new Error('Resource unavailable'), { status: 429 });
            throw error;
          }
          return { output_text: '# Handbook', usage: { input_tokens: 10, output_tokens: 5 } };
        },
      },
      post: async () => ({ input_tokens: 0 }),
    };

    const result = await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(2),
      plan: PLAN_ONE,
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    expect(result.markdown).toBe('# Handbook');
    expect(tiers).toEqual(['flex', 'default']);
  });

  it('does not retry when the tier is already the standard one', async () => {
    const bytes = await buildPdf(2);
    let calls = 0;
    const client: PdfLlmClient = {
      responses: {
        create: async () => {
          calls += 1;
          throw Object.assign(new Error('Resource unavailable'), { status: 429 });
        },
      },
      post: async () => ({ input_tokens: 0 }),
    };

    await expect(
      convertPdfChunks({
        workspaceId: 'W1',
        bytes,
        filename: 'handbook.pdf',
        inspection: inspection(2),
        plan: PLAN_ONE,
        config: config({ serviceTier: 'default' }),
        client,
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toThrow('Resource unavailable');
    expect(calls).toBe(1);
  });

  it('does not retry a failure that is not about capacity', async () => {
    const bytes = await buildPdf(2);
    let calls = 0;
    const client: PdfLlmClient = {
      responses: {
        create: async () => {
          calls += 1;
          throw Object.assign(new Error('Invalid request'), { status: 400 });
        },
      },
      post: async () => ({ input_tokens: 0 }),
    };

    await expect(
      convertPdfChunks({
        workspaceId: 'W1',
        bytes,
        filename: 'handbook.pdf',
        inspection: inspection(2),
        plan: PLAN_ONE,
        config: config(),
        client,
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toThrow('Invalid request');
    expect(calls).toBe(1);
  });

  it('fails when the model returns nothing', async () => {
    const bytes = await buildPdf(2);
    const client = fakeClient(['   ']);

    await expect(
      convertPdfChunks({
        workspaceId: 'W1',
        bytes,
        filename: 'handbook.pdf',
        inspection: inspection(2),
        plan: PLAN_ONE,
        config: config(),
        client,
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toThrow(/no markdown/i);
  });
});
