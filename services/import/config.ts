/**
 * The knobs the source-independent half of import reads from the environment.
 *
 * Only draft bookkeeping lives here. Source limits (`IMPORT_PDF_*`,
 * `IMPORT_WEB_*`) belong to the sources that enforce them, so a deploy tuning
 * one does not have to read this file.
 *
 * Values are read per call rather than frozen at module load: the draft store is
 * a long-lived singleton, and a test (or a `pnpm dev` restart under a changed
 * env) that sets a variable after this module was first required would otherwise
 * silently get the defaults.
 */

const MEGABYTE = 1024 * 1024;

export const DEFAULT_DRAFT_TTL_MIN = 15;
export const DEFAULT_DRAFT_MAX_TOTAL_BYTES = 50 * MEGABYTE;
export const DEFAULT_DRAFT_MAX_PER_USER = 5;

export interface ImportDraftConfig {
  /** How long a converted document waits for its commit before it is dropped. */
  ttlMs: number;
  /** Ceiling on everything held in memory across every workspace in this process. */
  maxTotalBytes: number;
  /** How many drafts one person may hold at once. */
  maxPerUser: number;
}

/**
 * A positive integer from the environment, or the default. Anything unparseable
 * or non-positive is a configuration mistake, and falling back beats running
 * with a zero TTL that expires every draft on creation.
 */
function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function draftConfig(): ImportDraftConfig {
  return {
    ttlMs: envInt('IMPORT_DRAFT_TTL_MIN', DEFAULT_DRAFT_TTL_MIN) * 60 * 1000,
    maxTotalBytes: envInt('IMPORT_DRAFT_MAX_TOTAL_BYTES', DEFAULT_DRAFT_MAX_TOTAL_BYTES),
    maxPerUser: envInt('IMPORT_DRAFT_MAX_PER_USER', DEFAULT_DRAFT_MAX_PER_USER),
  };
}
