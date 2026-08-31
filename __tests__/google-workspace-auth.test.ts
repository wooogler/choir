import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('workspace Google credential and doc mappings', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-google-auth-'));
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

  it('stores and reads back the workspace credential', async () => {
    await store.setGoogleAuth('T1', { refreshToken: 'rt-abc', email: 'a@example.com', connectedBy: 'U-manager' });

    const auth = await store.getGoogleAuth('T1');
    expect(auth?.refreshToken).toBe('rt-abc');
    expect(auth?.email).toBe('a@example.com');
    expect(auth?.connectedBy).toBe('U-manager');
    expect(auth?.connectedAt).toBeInstanceOf(Date);
  });

  it('keeps the refresh token out of the plaintext database file', async () => {
    await store.setGoogleAuth('T1', { refreshToken: 'super-secret-token', connectedBy: 'U-manager' });
    closeDatabase();

    const raw = fs.readFileSync(path.join(tempDir, 'choir.db'));
    expect(raw.includes(Buffer.from('super-secret-token'))).toBe(false);
  });

  it('replaces the credential when another manager reconnects', async () => {
    await store.setGoogleAuth('T1', { refreshToken: 'rt-one', connectedBy: 'U-manager' });
    await store.setGoogleAuth('T1', { refreshToken: 'rt-two', connectedBy: 'U-other' });

    const auth = await store.getGoogleAuth('T1');
    expect(auth?.refreshToken).toBe('rt-two');
    expect(auth?.connectedBy).toBe('U-other');
  });

  it('keeps document mappings when the credential is replaced or cleared', async () => {
    await store.setGoogleAuth('T1', { refreshToken: 'rt-one', connectedBy: 'U-manager' });
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://docs.google.com/document/d/file-a/edit',
      linkedBy: 'U-manager',
    });

    await store.clearGoogleAuth('T1');

    expect(await store.getGoogleAuth('T1')).toBeNull();
    // Mappings are addressed by fileId and survive a reconnect; dropping them
    // would orphan every replica on a routine token refresh.
    expect((await store.getGoogleDocMappings('T1'))['docs/a.md'].fileId).toBe('file-a');
  });

  it('marks the credential broken and back', async () => {
    await store.setGoogleAuth('T1', { refreshToken: 'rt', connectedBy: 'U-manager' });

    await store.setGoogleAuthBroken('T1', true);
    expect((await store.getGoogleAuth('T1'))?.broken).toBe(true);

    await store.setGoogleAuthBroken('T1', false);
    expect((await store.getGoogleAuth('T1'))?.broken).toBe(false);
  });

  it('ignores a broken flag when there is no credential', async () => {
    await expect(store.setGoogleAuthBroken('T1', true)).resolves.toBeUndefined();
    expect(await store.getGoogleAuth('T1')).toBeNull();
  });

  it('stores a document mapping with a hydrated date', async () => {
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://docs.google.com/document/d/file-a/edit',
      linkedBy: 'U-manager',
    });

    const mapping = await store.getGoogleDocMapping('T1', 'docs/a.md');
    expect(mapping?.fileId).toBe('file-a');
    expect(mapping?.linkedAt).toBeInstanceOf(Date);
  });

  it('rejects linking one Google Doc to two repo paths', async () => {
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://example.com/a',
      linkedBy: 'U-manager',
    });

    // Two documents publishing into one Doc would overwrite each other on every
    // sync, and drift could not be attributed to either.
    await expect(
      store.setGoogleDocMapping('T1', 'docs/b.md', {
        fileId: 'file-a',
        webViewLink: 'https://example.com/a',
        linkedBy: 'U-manager',
      }),
    ).rejects.toThrow('already linked to docs/a.md');

    expect(await store.getGoogleDocMapping('T1', 'docs/b.md')).toBeNull();
  });

  it('allows re-linking the same path to the same file', async () => {
    const mapping = { fileId: 'file-a', webViewLink: 'https://example.com/a', linkedBy: 'U-manager' };
    await store.setGoogleDocMapping('T1', 'docs/a.md', mapping);

    await expect(store.setGoogleDocMapping('T1', 'docs/a.md', mapping)).resolves.toBeUndefined();
  });

  it('removes a mapping and reports whether anything was removed', async () => {
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://example.com/a',
      linkedBy: 'U-manager',
    });

    expect(await store.removeGoogleDocMapping('T1', 'docs/a.md')).toBe(true);
    expect(await store.removeGoogleDocMapping('T1', 'docs/a.md')).toBe(false);
    expect(await store.getGoogleDocMappings('T1')).toEqual({});
  });

  it('does not lose a concurrent unrelated config change', async () => {
    await Promise.all([
      store.setGoogleAuth('T1', { refreshToken: 'rt', connectedBy: 'U-manager' }),
      store.setCHOIRUsers('T1', ['U-manager', 'U-extra']),
    ]);

    expect((await store.getGoogleAuth('T1'))?.refreshToken).toBe('rt');
    const config = await store.getWorkspaceConfig('T1');
    expect(config?.choirUsers).toEqual(expect.arrayContaining(['U-manager', 'U-extra']));
  });

  it('keeps every mapping when several documents are linked at once', async () => {
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) =>
        store.setGoogleDocMapping('T1', `docs/${name}.md`, {
          fileId: `file-${name}`,
          webViewLink: `https://example.com/${name}`,
          linkedBy: 'U-manager',
        }),
      ),
    );

    expect(Object.keys(await store.getGoogleDocMappings('T1')).sort()).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
      'docs/d.md',
    ]);
  });

  it('throws when the workspace does not exist', async () => {
    await expect(store.setGoogleAuth('T-missing', { refreshToken: 'rt', connectedBy: 'U' })).rejects.toThrow(
      'Workspace not found',
    );
  });
});
