import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Installation } from '@slack/oauth';
import { FileSlackInstallationStore } from 'services/slack/file-installation-store';

describe('FileSlackInstallationStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-installations-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores and fetches workspace installations by team id', async () => {
    const store = new FileSlackInstallationStore(tempDir);
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

  it('deletes workspace installations', async () => {
    const store = new FileSlackInstallationStore(tempDir);
    const installation: Installation<'v2', false> = {
      team: { id: 'T123' },
      enterprise: undefined,
      user: {
        token: undefined,
        scopes: undefined,
        id: 'U123',
      },
      isEnterpriseInstall: false,
      authVersion: 'v2',
    };

    await store.storeInstallation(installation);
    await store.deleteInstallation({
      teamId: 'T123',
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });

    await expect(
      store.fetchInstallation({
        teamId: 'T123',
        enterpriseId: undefined,
        isEnterpriseInstall: false,
      }),
    ).rejects.toThrow();
  });
});
