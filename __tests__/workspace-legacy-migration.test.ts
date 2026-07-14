import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { WorkspaceStore } from 'services/workspace/workspace-store';

describe('legacy workspace config migration deletes the plaintext file', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-legacy-'));
    process.env.CHOIR_DATA_DIR = tempDir;
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
  });

  it('migrates a plaintext legacy config into SQLite and removes the plaintext file', async () => {
    const workspaceId = 'T-legacy';
    const legacyPath = path.join(tempDir, `${workspaceId}-config.json`);
    // A legacy file with a GitHub token in cleartext, as older versions wrote it.
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        workspaceId,
        managers: ['U1'],
        choirUsers: ['U1'],
        organizationName: 'Legacy Org',
        githubTokens: { U1: { accessToken: 'ghp_secret', user: {}, connectedAt: new Date().toISOString() } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const store = new WorkspaceStore();
    const config = await store.getWorkspaceConfig(workspaceId);

    // Migrated correctly...
    expect(config?.organizationName).toBe('Legacy Org');
    expect(await store.getUserGithubToken(workspaceId, 'U1')).toBe('ghp_secret');
    // ...and the plaintext file is gone.
    expect(fs.existsSync(legacyPath)).toBe(false);

    // A subsequent read serves from SQLite (no legacy file needed).
    const again = await store.getWorkspaceConfig(workspaceId);
    expect(again?.organizationName).toBe('Legacy Org');
  });
});
