/**
 * The conversion itself: each planned chunk goes to the Responses API as an
 * `input_file`, and the markdown comes back.
 *
 * `input_file` gives the model both the PDF's text layer and a rendered image of
 * every page, which is why this path needs no OCR and why `detail` is worth
 * routing per chunk. What it cannot do is hold a 300-page document in one
 * answer, so chunks are sequential and each one is told where the previous one
 * left off — otherwise every chunk would restart the heading hierarchy from `#`.
 *
 * See docs/pdf-web-import.md, 결정 4 and "토큰 비용 — 긴 문서 대책".
 */

import { Logger } from 'services/common/logger';
import type { ImportProgressListener } from 'services/import/types';
import { resolveLLMConfig } from 'services/llm/llm-config';
import { getOpenAIClient } from 'services/llm/openai-client-factory';
import { slicePdf } from './chunk';
import { type PdfImportConfig, loadPdfImportConfig } from './config';
import type { PdfInspection } from './inspect';
import { type PdfChunk, type PdfImportPlan, countScannedPages, pageRangeLabel } from './plan';
import { buildTranscriptionPrompt } from './prompt';

/**
 * Generous: the spike transcribed 19 pages in 8,726 output tokens, so a 20-page
 * chunk has roughly twice the room it needs and nothing was ever truncated.
 */
const MAX_OUTPUT_TOKENS = 32000;

/**
 * Transcription is not a reasoning task. The spike ran every conversion at
 * `low` — 42–313 reasoning tokens — with fidelity 0.98+ and clean structure, so
 * anything more is paid for and thrown away.
 */
const REASONING_EFFORT = 'low' as const;

export interface PdfLlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PdfLlmResponse {
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

/**
 * The slice of the OpenAI client this module needs, so tests can hand in a fake
 * without constructing a real one. `post` is the escape hatch for endpoints the
 * installed SDK has no typed method for (see `estimate.ts`).
 */
export interface PdfLlmClient {
  responses: { create(body: PdfResponseRequest): Promise<PdfLlmResponse> };
  post(path: string, options: { body: unknown }): Promise<unknown>;
}

export interface PdfResponseRequest {
  model: string;
  input: unknown[];
  max_output_tokens?: number;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  service_tier?: 'flex' | 'default';
}

/**
 * Assembles the whole request around an `input` built by `buildChunkInput`.
 *
 * Everything that is *not* `input` lives here rather than in the input builder,
 * so the free token-count call can send the identical `input` and still be an
 * honest measurement of what the paid call will cost.
 */
export function buildChunkRequest(params: {
  model: string;
  input: unknown[];
  serviceTier: 'flex' | 'default';
}): PdfResponseRequest {
  return {
    model: params.model,
    input: params.input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: REASONING_EFFORT },
    service_tier: params.serviceTier,
  };
}

/**
 * Builds the `input` array for one chunk. Exported because the pre-flight
 * estimate must count tokens for *exactly* the payload the conversion will send;
 * any difference between the two makes the estimate a lie.
 */
export function buildChunkInput(params: {
  prompt: string;
  filename: string;
  pdfBytes: Buffer;
  detail: 'low' | 'high';
}): unknown[] {
  return [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: params.prompt },
        {
          type: 'input_file',
          filename: pdfFilename(params.filename),
          file_data: `data:application/pdf;base64,${params.pdfBytes.toString('base64')}`,
          // `detail` is accepted on `input_file` (it controls page-image
          // tokenization) but is absent from the openai@4.104 type for it.
          detail: params.detail,
        },
      ],
    },
  ];
}

/** The API rejects an `input_file` whose name does not look like a PDF. */
export function pdfFilename(filename: string): string {
  const trimmed = filename.trim() || 'document.pdf';
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}

/**
 * Wraps the real client in the narrow shape above. The casts are deliberate and
 * local: `input_file.detail` is not in openai@4.104's types, and `responses`
 * expects its own `ResponseCreateParams` rather than our open request shape.
 */
export function toPdfLlmClient(openai: ReturnType<typeof getOpenAIClient>): PdfLlmClient {
  return {
    responses: {
      create: (body) => openai.responses.create(body as never) as unknown as Promise<PdfLlmResponse>,
    },
    post: (path, options) => openai.post(path, options as never) as unknown as Promise<unknown>,
  };
}

/**
 * Picks the client and model to convert with. An injected client is used as-is;
 * an injected model with it skips the workspace lookup entirely, which is what
 * keeps the tests off the network and out of the workspace store.
 */
export async function resolvePdfLlm(
  workspaceId: string,
  client?: PdfLlmClient,
  model?: string,
): Promise<{ client: PdfLlmClient; model: string }> {
  if (client && model) return { client, model };
  const resolved = await resolveLLMConfig(workspaceId, 'qa');
  return {
    client: client ?? toPdfLlmClient(getOpenAIClient(resolved.apiKey)),
    model: model ?? resolved.model,
  };
}

export interface ConvertPdfChunksParams {
  workspaceId: string;
  /** The whole uploaded PDF; chunks are sliced out of it here. */
  bytes: Buffer;
  filename: string;
  inspection: PdfInspection;
  plan: PdfImportPlan;
  config?: PdfImportConfig;
  onProgress?: ImportProgressListener;
  client?: PdfLlmClient;
  model?: string;
}

export async function convertPdfChunks(
  params: ConvertPdfChunksParams,
): Promise<{ markdown: string; model: string; usage: PdfLlmUsage }> {
  const config = params.config ?? loadPdfImportConfig();
  const { client, model } = await resolvePdfLlm(params.workspaceId, params.client, params.model);

  const chunks = params.plan.chunks;
  const usage: PdfLlmUsage = { inputTokens: 0, outputTokens: 0 };
  const pieces: string[] = [];
  let headingPath: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const range = pageRangeLabel(chunk);
    report(params.onProgress, {
      step: 'converting',
      label: `Transcribing ${range} (${index + 1}/${chunks.length})`,
      current: index + 1,
      total: chunks.length,
    });

    const markdown = await convertChunk({
      client,
      model,
      chunk,
      bytes: params.bytes,
      filename: params.filename,
      title: params.inspection.title,
      isFirstChunk: index === 0,
      previousHeadingPath: headingPath,
      scannedPages: countScannedPages(chunk, params.inspection.scannedPages),
      serviceTier: config.serviceTier,
      usage,
    });

    pieces.push(markdown);
    headingPath = headingPathAtEnd(markdown);
  }

  return { markdown: pieces.join('\n\n'), model, usage };
}

async function convertChunk(params: {
  client: PdfLlmClient;
  model: string;
  chunk: PdfChunk;
  bytes: Buffer;
  filename: string;
  title?: string;
  isFirstChunk: boolean;
  previousHeadingPath: string[];
  scannedPages: number;
  serviceTier: 'flex' | 'default';
  usage: PdfLlmUsage;
}): Promise<string> {
  const pdfBytes = await slicePdf(params.bytes, params.chunk.from, params.chunk.to);
  const prompt = buildTranscriptionPrompt({
    filename: params.filename,
    title: params.title,
    pageRange: pageRangeLabel(params.chunk),
    isFirstChunk: params.isFirstChunk,
    previousHeadingPath: params.previousHeadingPath,
    scannedPages: params.scannedPages,
  });

  const request = buildChunkRequest({
    model: params.model,
    input: buildChunkInput({ prompt, filename: params.filename, pdfBytes, detail: params.chunk.detail }),
    serviceTier: params.serviceTier,
  });

  let response: PdfLlmResponse;
  try {
    response = await params.client.responses.create(request);
  } catch (error) {
    // Flex trades price for capacity, so "no capacity" is an expected answer,
    // not a failure: pay full price rather than lose the import.
    if (params.serviceTier !== 'flex' || !isCapacityError(error)) throw error;
    Logger.warn('PDF import: flex tier unavailable, retrying at the standard tier', {
      operation: 'import.pdf.convert',
      pages: pageRangeLabel(params.chunk),
    });
    response = await params.client.responses.create({ ...request, service_tier: 'default' });
  }

  params.usage.inputTokens += response.usage?.input_tokens ?? 0;
  params.usage.outputTokens += response.usage?.output_tokens ?? 0;

  const markdown = stripCodeFence(response.output_text ?? '');
  if (!markdown) {
    throw new Error(`The model returned no markdown for ${pageRangeLabel(params.chunk)}`);
  }
  return markdown;
}

/** 429, or an explicit `resource_unavailable`, both of which mean "try elsewhere". */
function isCapacityError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string; message?: string; error?: { code?: string } };
  if (candidate?.status === 429) return true;
  const code = candidate?.code ?? candidate?.error?.code ?? '';
  return /resource_unavailable/i.test(code) || /resource_unavailable/i.test(candidate?.message ?? '');
}

/**
 * Removes a fence the model wrapped the whole answer in. The prompt forbids it;
 * models do it anyway, and a document that opens with ```` ```markdown ```` is
 * visibly broken in the preview.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^(?:```|~~~)[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?(?:```|~~~)$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * The heading stack still open at the end of a chunk, outermost first. The next
 * chunk is told this so it continues the hierarchy instead of opening a new one.
 */
export function headingPathAtEnd(markdown: string): string[] {
  const stack: Array<{ level: number; text: string }> = [];
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;

    const level = heading[1].length;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: heading[2].trim() });
  }

  return stack.map((entry) => entry.text);
}

/** Progress is decoration: a listener that throws must not lose the conversion. */
function report(listener: ImportProgressListener | undefined, event: Parameters<ImportProgressListener>[0]): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // See above.
  }
}
