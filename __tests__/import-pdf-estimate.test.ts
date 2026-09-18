import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEFAULT_PDF_IMPORT_CONFIG, type PdfImportConfig } from 'services/import/sources/pdf/config';
import { estimatePdfImport, estimateUsd, priceFor } from 'services/import/sources/pdf/estimate';
import type { PdfInspection } from 'services/import/sources/pdf/inspect';
import { type PdfLlmClient, convertPdfChunks } from 'services/import/sources/pdf/llm-convert';
import type { PdfImportPlan } from 'services/import/sources/pdf/plan';

async function buildPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) {
    doc.addPage([595, 842]).drawText(`Page ${page}.`, { x: 50, y: 780, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

function inspection(pages: number, textPerPage: number, scannedPages: number[] = []): PdfInspection {
  const all = Array.from({ length: pages }, (_, index) => index + 1);
  return {
    pages,
    pageTexts: all.map((page) => (scannedPages.includes(page) ? '' : 'x'.repeat(textPerPage))),
    pageLines: all.map(() => []),
    textPages: all.filter((page) => !scannedPages.includes(page)),
    scannedPages,
    imagePages: scannedPages,
    blankPages: [],
  };
}

interface FakeClient extends PdfLlmClient {
  calls: Array<{ path: string; body: { model: string; input: unknown[] } }>;
}

function fakeClient(tokensPerCall: number[]): FakeClient {
  const calls: FakeClient['calls'] = [];
  return {
    calls,
    responses: {
      create: async () => {
        throw new Error('the estimate must not send a real conversion');
      },
    },
    post: async (path, options) => {
      calls.push({ path, body: options.body as { model: string; input: unknown[] } });
      return { input_tokens: tokensPerCall[calls.length - 1] ?? 0 };
    },
  };
}

function config(overrides: Partial<PdfImportConfig> = {}): PdfImportConfig {
  return { ...DEFAULT_PDF_IMPORT_CONFIG, ...overrides };
}

const PLAN_TWO: PdfImportPlan = {
  chunks: [
    { from: 1, to: 2, detail: 'low' },
    { from: 3, to: 4, detail: 'high' },
  ],
  scannedPages: [4],
};

describe('priceFor', () => {
  it('resolves a dated snapshot to its family', () => {
    expect(priceFor('gpt-5.4-mini-2026-03-17')).toEqual({ input: 0.75, output: 4.5 });
    expect(priceFor('gpt-4.1-mini')).toEqual({ input: 0.4, output: 1.6 });
  });

  it('prefers the longest matching prefix so a mini is never priced as its parent', () => {
    expect(priceFor('gpt-5.4-mini')).toEqual({ input: 0.75, output: 4.5 });
    expect(priceFor('gpt-5.4-nano')).toEqual({ input: 0.2, output: 1.25 });
    expect(priceFor('gpt-5.4')).toEqual({ input: 2.5, output: 15.0 });
  });

  it('knows nothing about a model it has no price for', () => {
    expect(priceFor('some-other-model')).toBeUndefined();
  });
});

describe('estimateUsd', () => {
  it('prices both directions and halves the total on flex', () => {
    expect(estimateUsd('gpt-5.4-mini', 1_000_000, 1_000_000, 'default')).toBeCloseTo(5.25, 6);
    expect(estimateUsd('gpt-5.4-mini', 1_000_000, 1_000_000, 'flex')).toBeCloseTo(2.625, 6);
  });

  it('gives no number rather than a wrong one for an unknown model', () => {
    expect(estimateUsd('llama-99', 1000, 1000, 'flex')).toBeUndefined();
  });
});

describe('estimatePdfImport', () => {
  it('counts tokens per chunk against the same payload the conversion sends', async () => {
    const bytes = await buildPdf(4);
    const client = fakeClient([1000, 3000]);

    const estimate = await estimatePdfImport({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(4, 300, [4]),
      plan: PLAN_TWO,
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].path).toBe('/responses/input_tokens');
    expect(client.calls[0].body.model).toBe('gpt-5.4-mini');

    const message = client.calls[0].body.input[0] as { content: Array<Record<string, string>> };
    expect(message.content[0].type).toBe('input_text');
    expect(message.content[1]).toMatchObject({ type: 'input_file', filename: 'handbook.pdf', detail: 'low' });
    expect((client.calls[1].body.input[0] as { content: Array<Record<string, string>> }).content[1].detail).toBe(
      'high',
    );

    expect(estimate.inputTokens).toBe(4000);
    expect(estimate.pages).toBe(4);
    expect(estimate.chunks).toBe(2);
    expect(estimate.scannedPages).toBe(1);
    expect(estimate.model).toBe('gpt-5.4-mini');
    expect(estimate.serviceTier).toBe('flex');
  });

  it('estimates output from the extracted text plus a budget per scanned page', async () => {
    const bytes = await buildPdf(4);

    const estimate = await estimatePdfImport({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      // 3 text pages × 300 chars = 900 chars → 225 tokens, plus 500 for page 4.
      inspection: inspection(4, 300, [4]),
      plan: PLAN_TWO,
      config: config(),
      client: fakeClient([1000, 3000]),
      model: 'gpt-5.4-mini',
    });

    expect(estimate.estimatedOutputTokens).toBe(725);
    // (4000 × 0.75 + 725 × 4.5) / 1e6, halved for flex.
    expect(estimate.estimatedUsd).toBeCloseTo(0.00313125, 8);
  });

  it('counts exactly the input the conversion sends', async () => {
    const bytes = await buildPdf(4);
    const inspected = inspection(4, 300, [3, 4]);
    const plan = { chunks: PLAN_TWO.chunks, scannedPages: [3, 4] };

    const estimateClient = fakeClient([10, 10]);
    await estimatePdfImport({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspected,
      plan,
      config: config(),
      client: estimateClient,
      model: 'gpt-5.4-mini',
    });

    const sent: unknown[] = [];
    await convertPdfChunks({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspected,
      plan,
      config: config(),
      model: 'gpt-5.4-mini',
      client: {
        responses: {
          create: async (request) => {
            sent.push(request.input);
            // Nothing outside `input` may leak into the counted payload.
            expect(request.reasoning).toEqual({ effort: 'low' });
            return { output_text: '# Handbook', usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
        post: async () => ({ input_tokens: 0 }),
      },
    });

    // The first chunk's prompt is identical; the second differs only in the
    // heading path, which the estimate stands in for.
    expect(JSON.stringify(sent[0])).toBe(JSON.stringify(estimateClient.calls[0].body.input));
  });

  it('gives a scanned chunk the scan instruction, so the count matches the paid call', async () => {
    const bytes = await buildPdf(4);
    const client = fakeClient([10, 10]);

    await estimatePdfImport({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(4, 300, [3, 4]),
      plan: { chunks: PLAN_TWO.chunks, scannedPages: [3, 4] },
      config: config(),
      client,
      model: 'gpt-5.4-mini',
    });

    const promptOf = (call: number) =>
      (client.calls[call].body.input[0] as { content: Array<Record<string, string>> }).content[0].text;
    expect(promptOf(0)).not.toContain('scans');
    expect(promptOf(1)).toContain('scans');
  });

  it('leaves the price out for a model it does not know', async () => {
    const bytes = await buildPdf(4);
    const estimate = await estimatePdfImport({
      workspaceId: 'W1',
      bytes,
      filename: 'handbook.pdf',
      inspection: inspection(4, 300),
      plan: PLAN_TWO,
      config: config(),
      client: fakeClient([10, 10]),
      model: 'an-unknown-model',
    });

    expect(estimate.estimatedUsd).toBeUndefined();
    expect(estimate.inputTokens).toBe(20);
  });

  it('refuses over the input-token cap, naming the count and the cap', async () => {
    const bytes = await buildPdf(4);

    await expect(
      estimatePdfImport({
        workspaceId: 'W1',
        bytes,
        filename: 'handbook.pdf',
        inspection: inspection(4, 300),
        plan: PLAN_TWO,
        config: config({ maxInputTokens: 1000 }),
        client: fakeClient([900, 900]),
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toMatchObject({
      name: 'ImportRefusal',
      status: 413,
      code: 'import_too_many_tokens',
      detail: { inputTokens: 1800, max: 1000 },
    });
  });

  it('fails loudly when the endpoint answers without a token count', async () => {
    const bytes = await buildPdf(4);
    const client: PdfLlmClient = {
      responses: { create: async () => ({}) },
      post: async () => ({}),
    };

    await expect(
      estimatePdfImport({
        workspaceId: 'W1',
        bytes,
        filename: 'handbook.pdf',
        inspection: inspection(4, 300),
        plan: PLAN_TWO,
        config: config(),
        client,
        model: 'gpt-5.4-mini',
      }),
    ).rejects.toThrow(/input_tokens/);
  });
});
