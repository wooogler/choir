/**
 * Shared helpers for the PDF / web import spike (P0 of docs/pdf-web-import.md).
 *
 * Not product code. Nothing here is imported by the app.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dotenv from 'dotenv';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const OUT_DIR = path.join(__dirname, 'out');

/** Scratchpad for generated PDFs and other throwaway artefacts. */
export const SCRATCH =
  process.env.SPIKE_SCRATCH ||
  '/tmp/claude-1000/-home-sangwonlee-choir/bc75310f-e495-4d09-9f72-e8d96901f237/scratchpad';

export const SAMPLES_DIR = path.join(SCRATCH, 'samples');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

// ---------------------------------------------------------------- pricing ---

/** USD per 1M tokens, standard tier. Flex is half of both. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number, tier: 'flex' | 'default'): number {
  const p = PRICING[model];
  if (!p) throw new Error(`no pricing for ${model}`);
  const mult = tier === 'flex' ? 0.5 : 1;
  return ((inputTokens * p.input) / 1e6 + (outputTokens * p.output) / 1e6) * mult;
}

// ------------------------------------------------------------------ openai ---

export function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing from .env');
  return key;
}

export async function openaiClient() {
  const OpenAI = (await import('openai')).default;
  return new OpenAI({ apiKey: requireApiKey(), timeout: 15 * 60 * 1000, maxRetries: 0 });
}

/**
 * openai 4.104 has no `client.responses.inputTokens`; the endpoint exists and
 * is free, so we post to it directly.
 */
export async function countInputTokens(client: any, model: string, input: unknown): Promise<number> {
  const res: any = await client.post('/responses/input_tokens', { body: { model, input } });
  if (typeof res?.input_tokens !== 'number') {
    throw new Error(`unexpected input_tokens response: ${JSON.stringify(res).slice(0, 300)}`);
  }
  return res.input_tokens;
}

// -------------------------------------------------------------------- pdfjs ---

export interface PageText {
  pageNumber: number;
  text: string;
  chars: number;
  /** rounded `height` of each text item, for the heading-detection probe */
  heights: number[];
}

export interface PdfInfo {
  numPages: number;
  pages: PageText[];
  title?: string;
  encrypted: boolean;
  /** milliseconds spent in pdfjs */
  ms: number;
}

/** pdfjs-dist legacy build, no canvas: text + metadata only. */
export async function readPdf(file: string): Promise<PdfInfo> {
  const started = Date.now();
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = fs.readFileSync(file);
  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
  } catch (err: any) {
    if (err?.name === 'PasswordException') {
      return { numPages: 0, pages: [], encrypted: true, ms: Date.now() - started };
    }
    throw err;
  }
  const pages: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const parts: string[] = [];
    const heights: number[] = [];
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      parts.push(item.str);
      if (item.str.trim() && typeof item.height === 'number' && item.height > 0) {
        heights.push(Math.round(item.height * 10) / 10);
      }
      if (item.hasEOL) parts.push('\n');
    }
    const text = parts
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    pages.push({ pageNumber: i, text, chars: text.length, heights });
  }
  let title: string | undefined;
  try {
    const meta = await doc.getMetadata();
    title = (meta?.info as any)?.Title || undefined;
  } catch {
    /* ignore */
  }
  return { numPages: doc.numPages, pages, title, encrypted: false, ms: Date.now() - started };
}

// ------------------------------------------------------------------ pdf-lib ---

/** Copy a 1-based inclusive page range into a new PDF file. Returns the path. */
export async function slicePdf(src: string, from: number, to: number, destPath: string): Promise<string> {
  const { PDFDocument } = await import('pdf-lib');
  const srcDoc = await PDFDocument.load(fs.readFileSync(src), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const indices: number[] = [];
  for (let i = from - 1; i <= to - 1 && i < srcDoc.getPageCount(); i++) indices.push(i);
  const copied = await out.copyPages(srcDoc, indices);
  for (const p of copied) out.addPage(p);
  fs.writeFileSync(destPath, Buffer.from(await out.save()));
  return destPath;
}

// ----------------------------------------------------------------- fidelity ---

/** NFKC, lowercase, strip whitespace and punctuation. */
export function normalizeForFidelity(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s]+/g, '')
    .replace(/[!-/:-@[-`{-~ -⁯　-〿]/g, '');
}

/** Fraction of the source's character 5-grams that survive in the output. */
export function fidelity(sourceText: string, outputMarkdown: string, n = 5): number {
  const src = normalizeForFidelity(sourceText);
  const out = normalizeForFidelity(outputMarkdown);
  if (src.length < n) return 1;
  const outGrams = new Set<string>();
  for (let i = 0; i + n <= out.length; i++) outGrams.add(out.slice(i, i + n));
  let total = 0;
  let hit = 0;
  const seen = new Set<string>();
  for (let i = 0; i + n <= src.length; i++) {
    const g = src.slice(i, i + n);
    if (seen.has(g)) continue; // distinct n-grams, so repetition does not dominate
    seen.add(g);
    total++;
    if (outGrams.has(g)) hit++;
  }
  return total === 0 ? 1 : hit / total;
}

// -------------------------------------------------------------------- misc ---

export function fileToDataUrl(file: string): string {
  return `data:application/pdf;base64,${fs.readFileSync(file).toString('base64')}`;
}

export function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
}

export function stripFence(md: string): { text: string; wasFenced: boolean } {
  const m = md.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  if (m) return { text: m[1], wasFenced: true };
  return { text: md, wasFenced: false };
}

export function fmt(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
