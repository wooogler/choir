import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EMBED_MODEL_LABEL,
  ensureEmbedModelUpToDate,
  getConfiguredEmbedModel,
  getIndexMetaPath,
  getVectorSearchFailureCount,
  readIndexMeta,
  recordVectorSearchFailure,
  resetVectorSearchFailureCount,
  writeIndexMeta,
} from '@/services/retrieval/qmd-embed-guard';

const QWEN = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';

describe('qmd embed-model guard', () => {
  let tempDir: string;
  let dbPath: string;
  const originalEmbedModel = process.env.QMD_EMBED_MODEL;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-embed-guard-'));
    dbPath = path.join(tempDir, 'state', 'qmd-index-v2.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Empty reads the same as unset through getConfiguredEmbedModel().
    process.env.QMD_EMBED_MODEL = '';
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env.QMD_EMBED_MODEL = originalEmbedModel ?? '';
  });

  it('names the sidecar next to the sqlite file', () => {
    expect(getIndexMetaPath('/data/ws/state/qmd-index-v2.sqlite')).toBe('/data/ws/state/qmd-index-v2.meta.json');
  });

  it('labels an unset QMD_EMBED_MODEL as "default"', () => {
    expect(getConfiguredEmbedModel()).toBe(DEFAULT_EMBED_MODEL_LABEL);
    process.env.QMD_EMBED_MODEL = QWEN;
    expect(getConfiguredEmbedModel()).toBe(QWEN);
  });

  it('writes the sidecar on first init and does not re-embed', async () => {
    const reembed = jest.fn(async () => undefined);

    const outcome = await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed });

    expect(outcome).toBe('initialized');
    expect(reembed).not.toHaveBeenCalled();
    const meta = readIndexMeta(dbPath);
    expect(meta?.embedModel).toBe(DEFAULT_EMBED_MODEL_LABEL);
    expect(meta?.embeddedAt).toEqual(expect.any(String));
  });

  it('does nothing when the sidecar matches the configured model', async () => {
    process.env.QMD_EMBED_MODEL = QWEN;
    const written = await writeIndexMeta(dbPath, QWEN);
    const reembed = jest.fn(async () => undefined);

    const outcome = await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed });

    expect(outcome).toBe('matched');
    expect(reembed).not.toHaveBeenCalled();
    // Untouched: same timestamp as before the check.
    expect(readIndexMeta(dbPath)).toEqual(written);
  });

  it('forces one re-embed and rewrites the sidecar when the model changed', async () => {
    await writeIndexMeta(dbPath, DEFAULT_EMBED_MODEL_LABEL);
    process.env.QMD_EMBED_MODEL = QWEN;
    const reembed = jest.fn(async () => undefined);

    const outcome = await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed });

    expect(outcome).toBe('re-embedded');
    expect(reembed).toHaveBeenCalledTimes(1);
    expect(readIndexMeta(dbPath)?.embedModel).toBe(QWEN);

    // The rewritten sidecar means the next start is a plain match: the expensive
    // re-embed must not run again on every restart.
    const secondReembed = jest.fn(async () => undefined);
    expect(await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed: secondReembed })).toBe('matched');
    expect(secondReembed).not.toHaveBeenCalled();
  });

  it('leaves the sidecar stale when the forced re-embed fails, so the next start retries', async () => {
    await writeIndexMeta(dbPath, DEFAULT_EMBED_MODEL_LABEL);
    process.env.QMD_EMBED_MODEL = QWEN;
    const reembed = jest.fn(async () => {
      throw new Error('llama.cpp exploded');
    });

    const outcome = await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed });

    expect(outcome).toBe('failed');
    expect(readIndexMeta(dbPath)?.embedModel).toBe(DEFAULT_EMBED_MODEL_LABEL);

    const retry = jest.fn(async () => undefined);
    expect(await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed: retry })).toBe('re-embedded');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt sidecar as missing', async () => {
    fs.writeFileSync(getIndexMetaPath(dbPath), '{ not json', 'utf-8');
    const reembed = jest.fn(async () => undefined);

    expect(readIndexMeta(dbPath)).toBeNull();
    expect(await ensureEmbedModelUpToDate({ workspaceId: 'T1', dbPath, reembed })).toBe('initialized');
    expect(reembed).not.toHaveBeenCalled();
    expect(readIndexMeta(dbPath)?.embedModel).toBe(DEFAULT_EMBED_MODEL_LABEL);
  });

  it('counts vector-search failures', () => {
    resetVectorSearchFailureCount();
    expect(getVectorSearchFailureCount()).toBe(0);
    expect(recordVectorSearchFailure()).toBe(1);
    recordVectorSearchFailure();
    expect(getVectorSearchFailureCount()).toBe(2);
    resetVectorSearchFailureCount();
    expect(getVectorSearchFailureCount()).toBe(0);
  });
});
