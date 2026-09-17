import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';

/**
 * Guards the QMD index against a silent embedding-model swap.
 *
 * QMD reads `QMD_EMBED_MODEL` at module import time and `createStore` takes no
 * embedding-model option, so changing the env var changes the vectors QMD
 * *writes* but not the ones already in `content_vectors` — the stored `model`
 * column is a bare label nothing checks, and re-embedding only ever visits rows
 * that have no vector at all. Mixing a 768-d index with a 1024-d query vector
 * makes the `vectors_vec MATCH` throw, which used to be swallowed into a quiet
 * lexical fallback: retrieval quality drops with no visible failure.
 *
 * So CHOIR records the model the index was actually built with in a small JSON
 * sidecar next to the sqlite file and compares it on every store init.
 */

/** Label stored when `QMD_EMBED_MODEL` is unset (QMD's own built-in default). */
export const DEFAULT_EMBED_MODEL_LABEL = 'default';

export interface QmdIndexMeta {
  /** `process.env.QMD_EMBED_MODEL` at the time the index was embedded. */
  embedModel: string;
  /** ISO timestamp of the embed run this sidecar describes. */
  embeddedAt: string;
}

export type EmbedGuardOutcome =
  /** No sidecar existed; one was written for the index as it stands. */
  | 'initialized'
  /** Sidecar matches the configured model; nothing to do. */
  | 'matched'
  /** Sidecar disagreed; a forced re-embed ran and the sidecar was rewritten. */
  | 're-embedded'
  /** Sidecar disagreed but the forced re-embed failed; sidecar left stale. */
  | 'failed';

export function getConfiguredEmbedModel(): string {
  return process.env.QMD_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL_LABEL;
}

/** `<dir>/qmd-index-v2.sqlite` → `<dir>/qmd-index-v2.meta.json`. */
export function getIndexMetaPath(dbPath: string): string {
  const directory = path.dirname(dbPath);
  const base = path.basename(dbPath, path.extname(dbPath));
  return path.join(directory, `${base}.meta.json`);
}

export function readIndexMeta(dbPath: string): QmdIndexMeta | null {
  const metaPath = getIndexMetaPath(dbPath);

  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<QmdIndexMeta>;
    if (typeof parsed.embedModel !== 'string' || !parsed.embedModel) {
      return null;
    }

    return {
      embedModel: parsed.embedModel,
      embeddedAt: typeof parsed.embeddedAt === 'string' ? parsed.embeddedAt : '',
    };
  } catch {
    // Missing or unreadable/corrupt sidecar is treated as "unknown", which the
    // caller resolves by writing a fresh one.
    return null;
  }
}

export async function writeIndexMeta(dbPath: string, embedModel: string): Promise<QmdIndexMeta> {
  const meta: QmdIndexMeta = { embedModel, embeddedAt: new Date().toISOString() };
  const metaPath = getIndexMetaPath(dbPath);

  await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.promises.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');

  return meta;
}

/**
 * Compares the sidecar against `QMD_EMBED_MODEL` and, on a mismatch, runs
 * `reembed` (the forced full re-embed) before the store serves any query.
 *
 * A missing sidecar is assumed to describe the *current* model: on the first
 * deploy of this guard the existing index was built with whatever the env says
 * today, and forcing a multi-hour CPU re-embed on every instance at once would
 * be worse than the risk it avoids.
 */
export async function ensureEmbedModelUpToDate(params: {
  workspaceId: string;
  dbPath: string;
  reembed: () => Promise<unknown>;
}): Promise<EmbedGuardOutcome> {
  const configuredModel = getConfiguredEmbedModel();
  const meta = readIndexMeta(params.dbPath);

  if (!meta) {
    await writeIndexMeta(params.dbPath, configuredModel);
    Logger.info('QmdRetrievalProvider: recorded the embedding model for this QMD index.', {
      workspaceId: params.workspaceId,
      embedModel: configuredModel,
      metaPath: getIndexMetaPath(params.dbPath),
    });
    return 'initialized';
  }

  if (meta.embedModel === configuredModel) {
    return 'matched';
  }

  Logger.warn(
    'QmdRetrievalProvider: QMD_EMBED_MODEL changed since this index was embedded. Forcing a full re-embed before serving searches; this can take a long time on CPU.',
    {
      workspaceId: params.workspaceId,
      indexedWith: meta.embedModel,
      configured: configuredModel,
      indexedAt: meta.embeddedAt,
      dbPath: params.dbPath,
    },
  );

  try {
    await params.reembed();
  } catch (error) {
    // Leave the sidecar stale on purpose: the index still holds vectors from the
    // old model, and the next start must retry rather than believe the swap took.
    Logger.error(
      'QmdRetrievalProvider: forced re-embed after an embedding-model change failed. The index still holds vectors from the previous model, so vector search will fail until it is rebuilt (App Home → Rebuild index).',
      error as Error,
      {
        workspaceId: params.workspaceId,
        indexedWith: meta.embedModel,
        configured: configuredModel,
      },
    );
    return 'failed';
  }

  await writeIndexMeta(params.dbPath, configuredModel);
  Logger.info('QmdRetrievalProvider: re-embedded the QMD index for the new embedding model.', {
    workspaceId: params.workspaceId,
    embedModel: configuredModel,
  });

  return 're-embedded';
}

let vectorSearchFailureCount = 0;

/**
 * Counts hybrid-search failures so the quiet lexical fallback is visible in the
 * warm-up / init log lines instead of only in a single warning at answer time.
 */
export function recordVectorSearchFailure(): number {
  vectorSearchFailureCount += 1;
  return vectorSearchFailureCount;
}

export function getVectorSearchFailureCount(): number {
  return vectorSearchFailureCount;
}

export function resetVectorSearchFailureCount(): void {
  vectorSearchFailureCount = 0;
}

/** Operator-facing hint attached to every hybrid-search failure. */
export const VECTOR_SEARCH_FAILURE_HINT =
  'Hybrid (vector) search failed and the query fell back to lexical-only results. The usual cause is an index embedded with a different QMD_EMBED_MODEL than the one configured now (vector dimensions disagree). Rebuild the index from App Home → Rebuild index, or restore the previous QMD_EMBED_MODEL value.';
