/**
 * What this conversion will cost, before a single token is spent.
 *
 * The workspace's own OpenAI key pays for the import, so the manager gets to see
 * the bill first — that is the whole reason this exists, and why the numbers are
 * measured against the real payload rather than guessed from page counts. The
 * token-count endpoint is free, so asking is cheaper than being wrong.
 *
 * Input is measured, never modelled: the P0 spike found that `input_file` does
 * not rasterise pure-text pages at all (a text page costs ~470 tokens at both
 * detail levels), while a page with vector graphics costs a flat ~1,881 more at
 * `high` and an embedded raster ~630 at `low` / ~1,500 at `high`. No per-page
 * formula survives that spread, and the count endpoint costs nothing. Only the
 * output side is estimated, and it is ~85% of the bill.
 *
 * See docs/pdf-web-import.md, "토큰 비용 — 긴 문서 대책" item 2, and
 * scripts/spike-import/RESULTS.md.
 */

import type { GlossaryEntry, GlossaryLanguage } from 'services/glossary';
import { ImportRefusal } from 'services/import/types';
import { slicePdf } from './chunk';
import { type PdfImportConfig, loadPdfImportConfig } from './config';
import type { PdfInspection } from './inspect';
import { type PdfLlmClient, buildChunkInput, chunkSourceText, resolvePdfLlm } from './llm-convert';
import { type PdfImportPlan, countScannedPages, pageRangeLabel } from './plan';
import { buildTranscriptionPrompt } from './prompt';

/** POST /v1/responses/input_tokens — free, and takes the same `input` as a real call. */
const INPUT_TOKENS_PATH = '/responses/input_tokens';

/**
 * Output tokens per extracted source character, measured in the P0 spike: 0.21
 * for prose, 0.38 for a table-heavy page where GFM pipes inflate it. 0.25 sits
 * just above the common case, which is the right side to be wrong on for a
 * number a manager approves a bill against.
 */
const OUTPUT_TOKENS_PER_CHAR = 0.25;

/**
 * A scanned page has no extracted text to measure, so it gets a flat budget.
 * Measured output was 459–541 tokens for a full page.
 */
const OUTPUT_TOKENS_PER_SCANNED_PAGE = 500;

/** USD per 1M tokens at the standard tier; flex is half of both. */
interface ModelPrice {
  input: number;
  output: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};

/**
 * Longest prefix wins so a dated snapshot resolves to its family and
 * `gpt-5.4-mini-…` is never priced as `gpt-5.4`. An unknown model returns
 * nothing: a wrong price is worse than no price.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const name = model.trim().toLowerCase();
  const match = Object.keys(MODEL_PRICES)
    .filter((prefix) => name.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return match ? MODEL_PRICES[match] : undefined;
}

export interface PdfImportEstimate {
  pages: number;
  scannedPages: number;
  chunks: number;
  inputTokens: number;
  estimatedOutputTokens: number;
  /** Absent when we do not know what the configured model costs. */
  estimatedUsd?: number;
  model: string;
  serviceTier: string;
}

export interface EstimatePdfImportParams {
  workspaceId: string;
  bytes: Buffer;
  filename: string;
  inspection: PdfInspection;
  plan: PdfImportPlan;
  config?: PdfImportConfig;
  client?: PdfLlmClient;
  model?: string;
  /**
   * Must be the same glossary the conversion will be given: the block is real
   * prompt text, and counting a payload without it under-quotes the bill.
   */
  glossary?: GlossaryEntry[];
  language?: GlossaryLanguage;
}

export async function estimatePdfImport(params: EstimatePdfImportParams): Promise<PdfImportEstimate> {
  const config = params.config ?? loadPdfImportConfig();
  const { client, model } = await resolvePdfLlm(params.workspaceId, params.client, params.model);

  let inputTokens = 0;
  for (let index = 0; index < params.plan.chunks.length; index += 1) {
    const chunk = params.plan.chunks[index];
    const pdfBytes = await slicePdf(params.bytes, chunk.from, chunk.to);
    const prompt = buildTranscriptionPrompt({
      filename: params.filename,
      title: params.inspection.title,
      pageRange: pageRangeLabel(chunk),
      isFirstChunk: index === 0,
      // The estimate cannot know the real heading path (it comes from the
      // previous chunk's answer); a one-entry stand-in keeps the prompt the
      // same length to within a token or two.
      previousHeadingPath: index === 0 ? [] : [params.inspection.title ?? params.filename],
      // Must match the conversion: the scan instruction is a real chunk of
      // prompt, and a chunk that gets it costs more than one that does not.
      scannedPages: countScannedPages(chunk, params.inspection.scannedPages),
      // Same glossary, same chunk text, same cap as the conversion — the block
      // it selects is therefore byte-identical.
      glossary: params.glossary,
      glossaryText: chunkSourceText(params.inspection, chunk),
      language: params.language,
    });
    const input = buildChunkInput({ prompt, filename: params.filename, pdfBytes, detail: chunk.detail });
    inputTokens += await countInputTokens(client, model, input);
  }

  if (inputTokens > config.maxInputTokens) {
    throw new ImportRefusal(413, 'import_too_many_tokens', { inputTokens, max: config.maxInputTokens });
  }

  const extractedChars = params.inspection.pageTexts.reduce((total, text) => total + text.length, 0);
  const estimatedOutputTokens =
    Math.ceil(extractedChars * OUTPUT_TOKENS_PER_CHAR) +
    OUTPUT_TOKENS_PER_SCANNED_PAGE * params.plan.scannedPages.length;

  return {
    pages: params.inspection.pages,
    scannedPages: params.plan.scannedPages.length,
    chunks: params.plan.chunks.length,
    inputTokens,
    estimatedOutputTokens,
    estimatedUsd: estimateUsd(model, inputTokens, estimatedOutputTokens, config.serviceTier),
    model,
    serviceTier: config.serviceTier,
  };
}

export function estimateUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  serviceTier: 'flex' | 'default',
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const discount = serviceTier === 'flex' ? 0.5 : 1;
  return ((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * discount;
}

async function countInputTokens(client: PdfLlmClient, model: string, input: unknown[]): Promise<number> {
  const result = (await client.post(INPUT_TOKENS_PATH, { body: { model, input } })) as {
    input_tokens?: number;
  } | null;
  const tokens = result?.input_tokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
    throw new Error('The token-count endpoint returned no input_tokens');
  }
  return tokens;
}
