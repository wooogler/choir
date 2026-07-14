import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U1'],
  choirUsers: ['U1'],
  organizationName: workspaceId,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('provenance context key lifecycle (backs the App Home key UI)', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-ctxkey-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;
    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  it('reports not-configured until a key is created', async () => {
    expect((await store.getContextKeyStatus('T1')).configured).toBe(false);
    expect(await store.getContextEncryptionKey('T1')).toBeNull();
  });

  it('generates and persists a key on first use', async () => {
    const key = await store.getOrCreateContextKey('T1');
    expect(key.length).toBe(32);

    const status = await store.getContextKeyStatus('T1');
    expect(status.configured).toBe(true);
    expect(status.createdAt).toBeTruthy();
    expect(status.rotatedAt).toBeUndefined();

    // Idempotent: a second call returns the SAME key (no silent regeneration).
    const again = await store.getOrCreateContextKey('T1');
    expect(again.toString('base64')).toBe(key.toString('base64'));
  });

  it('rotate replaces the key and stamps rotatedAt while preserving createdAt', async () => {
    const original = await store.getOrCreateContextKey('T1');
    const createdAt = (await store.getContextKeyStatus('T1')).createdAt;

    const status = await store.rotateContextKey('T1');
    expect(status.configured).toBe(true);
    expect(status.rotatedAt).toBeTruthy();
    expect(status.createdAt).toBe(createdAt); // creation time is kept

    const rotated = await store.getContextEncryptionKey('T1');
    expect(rotated?.toString('base64')).not.toBe(original.toString('base64'));
  });

  it('imports an exact base64 key (bring-your-own-key)', async () => {
    const imported = crypto.randomBytes(32);
    await store.rotateContextKey('T1', { importKeyBase64: imported.toString('base64') });

    const stored = await store.getContextEncryptionKey('T1');
    expect(stored?.toString('base64')).toBe(imported.toString('base64'));
  });

  it('rejects an import key that is not 32 bytes', async () => {
    await expect(
      store.rotateContextKey('T1', { importKeyBase64: Buffer.from('too-short').toString('base64') }),
    ).rejects.toThrow(/32-byte/);
    // A rejected import must not have changed anything.
    expect((await store.getContextKeyStatus('T1')).configured).toBe(false);
  });
});
