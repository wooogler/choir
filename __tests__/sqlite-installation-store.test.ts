import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Installation } from '@slack/oauth';
import { closeDatabase } from 'services/db/connection';
import { SqliteSlackInstallationStore } from 'services/slack/sqlite-installation-store';

describe('SqliteSlackInstallationStore', () => {
  let tempDir: string;

  beforeEach(() => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-sqlite-installations-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
  });

  it('stores and fetches encrypted workspace installations by team id', async () => {
    const store = new SqliteSlackInstallationStore(path.join(tempDir, 'legacy-installations'));
    const installation: Installation<'v2', false> = {
      team: { id: 'T123', name: 'Example' },
      enterprise: undefined,
      user: {
        token: undefined,
        scopes: undefined,
        id: 'U123',
      },
      bot: {
        token: 'xoxb-token',
        scopes: ['chat:write'],
        id: 'B123',
        userId: 'U999',
      },
      isEnterpriseInstall: false,
      authVersion: 'v2',
    };

    await store.storeInstallation(installation);

    await expect(
      store.fetchInstallation({
        teamId: 'T123',
        enterpriseId: undefined,
        isEnterpriseInstall: false,
      }),
    ).resolves.toEqual(installation);
  });
});
