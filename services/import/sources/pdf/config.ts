/**
 * The knobs PDF import reads from the environment.
 *
 * Every limit here exists to bound one of three things: what we accept from the
 * manager (bytes, pages), what we spend on their OpenAI key (input tokens,
 * detail, service tier), and how much we trust the result (fidelity threshold).
 * Parsing lives apart from the pipeline so the whole of it can be exercised with
 * an explicit config object and no environment at all.
 *
 * See docs/pdf-web-import.md, "결정 4. PDF 변환" and the 설정 table.
 */

export type PdfDetailMode = 'auto' | 'low' | 'high';
export type PdfServiceTier = 'flex' | 'default';
export type PdfConversionMode = 'auto' | 'llm' | 'text';

export interface PdfImportConfig {
  /** Upload cap; the route's `express.raw` limit must match. */
  maxBytes: number;
  maxPages: number;
  /** Pre-flight estimate above this is refused rather than sent. */
  maxInputTokens: number;
  /** Sized by wall time, not tokens: the spike measured ~2.9 s/page, so 20 keeps a request near a minute. */
  chunkPages: number;
  /** `auto` routes per page: text pages go `low`, scanned pages `high`. */
  detail: PdfDetailMode;
  serviceTier: PdfServiceTier;
  mode: PdfConversionMode;
  /** Below this n-gram coverage the result carries a `low_fidelity` warning. */
  fidelityThreshold: number;
  /** A page with fewer extracted characters than this counts as scanned. */
  textPageMinChars: number;
}

export const DEFAULT_PDF_IMPORT_CONFIG: PdfImportConfig = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 200,
  maxInputTokens: 400_000,
  chunkPages: 20,
  detail: 'auto',
  serviceTier: 'flex',
  mode: 'auto',
  fidelityThreshold: 0.85,
  textPageMinChars: 200,
};

type Env = Record<string, string | undefined>;

/**
 * A malformed value is ignored rather than fatal: a typo in one env var should
 * fall back to the documented default, not stop every import in the workspace.
 */
function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratio(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key]?.trim().toLowerCase();
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function loadPdfImportConfig(env: Env = process.env): PdfImportConfig {
  return {
    maxBytes: positiveInt(env, 'IMPORT_PDF_MAX_BYTES', DEFAULT_PDF_IMPORT_CONFIG.maxBytes),
    maxPages: positiveInt(env, 'IMPORT_PDF_MAX_PAGES', DEFAULT_PDF_IMPORT_CONFIG.maxPages),
    maxInputTokens: positiveInt(env, 'IMPORT_PDF_MAX_INPUT_TOKENS', DEFAULT_PDF_IMPORT_CONFIG.maxInputTokens),
    chunkPages: positiveInt(env, 'IMPORT_PDF_CHUNK_PAGES', DEFAULT_PDF_IMPORT_CONFIG.chunkPages),
    detail: oneOf(env, 'IMPORT_PDF_DETAIL', ['auto', 'low', 'high'] as const, DEFAULT_PDF_IMPORT_CONFIG.detail),
    serviceTier: oneOf(
      env,
      'IMPORT_PDF_SERVICE_TIER',
      ['flex', 'default'] as const,
      DEFAULT_PDF_IMPORT_CONFIG.serviceTier,
    ),
    mode: oneOf(env, 'IMPORT_PDF_MODE', ['auto', 'llm', 'text'] as const, DEFAULT_PDF_IMPORT_CONFIG.mode),
    fidelityThreshold: ratio(env, 'IMPORT_PDF_FIDELITY_THRESHOLD', DEFAULT_PDF_IMPORT_CONFIG.fidelityThreshold),
    textPageMinChars: positiveInt(env, 'IMPORT_PDF_TEXT_PAGE_MIN_CHARS', DEFAULT_PDF_IMPORT_CONFIG.textPageMinChars),
  };
}
