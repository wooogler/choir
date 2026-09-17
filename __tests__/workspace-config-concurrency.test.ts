import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  organizationName: workspaceId,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const githubUser = {
  id: 1,
  login: 'octocat',
  name: 'Octo Cat',
  email: 'octo@example.com',
  avatar_url: 'https://example.com/a.png',
};

describe('workspace config concurrent mutations (lost-update race)', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-wsconfig-'));
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

  it('preserves both fields when two different mutators run concurrently', async () => {
    // Two RMW mutators of DIFFERENT fields racing. The old get→mutate→save
    // sequence would let the second save clobber the first's field; the atomic
    // path must keep both.
    await Promise.all([
      store.setUserGithubToken('T1', 'U-manager', { accessToken: 'tok-abc', user: githubUser }),
      store.setCHOIRUsers('T1', ['U-manager', 'U-extra']),
    ]);

    expect(await store.getUserGithubToken('T1', 'U-manager')).toBe('tok-abc');
    const config = await store.getWorkspaceConfig('T1');
    expect(config?.choirUsers).toEqual(expect.arrayContaining(['U-manager', 'U-extra']));
  });

  it('keeps every user when many addCHOIRUser calls race', async () => {
    const users = Array.from({ length: 25 }, (_, i) => `U-${i}`);
    await Promise.all(users.map((u) => store.addCHOIRUser('T1', u)));

    const config = await store.getWorkspaceConfig('T1');
    for (const u of users) {
      expect(config?.choirUsers).toContain(u);
    }
    // The seed manager plus 25 distinct additions, no duplicates dropped.
    expect(new Set(config?.choirUsers).size).toBe(config?.choirUsers.length);
  });

  it('keeps a per-user language set while the CHOIR user list is rewritten', async () => {
    await Promise.all([
      store.setUserLanguage('T1', 'U-manager', 'ko'),
      store.setCHOIRUsers('T1', ['U-manager', 'U-extra']),
      store.setWorkspaceLanguage('T1', 'ko'),
    ]);

    expect(await store.getUserLanguage('T1', 'U-manager')).toBe('ko');
    expect(await store.getWorkspaceLanguage('T1')).toBe('ko');
    const config = await store.getWorkspaceConfig('T1');
    expect(config?.choirUsers).toEqual(expect.arrayContaining(['U-manager', 'U-extra']));
  });

  it('keeps every user language when many setUserLanguage calls race', async () => {
    const users = Array.from({ length: 20 }, (_, i) => `U-${i}`);
    await Promise.all(users.map((u, i) => store.setUserLanguage('T1', u, i % 2 === 0 ? 'ko' : 'en')));

    const config = await store.getWorkspaceConfig('T1');
    expect(Object.keys(config?.userLanguages ?? {})).toHaveLength(users.length);
    expect(config?.userLanguages?.['U-0']).toBe('ko');
    expect(config?.userLanguages?.['U-1']).toBe('en');
  });

  it('clears a user language back to automatic', async () => {
    await store.setUserLanguage('T1', 'U-manager', 'ko');
    await store.setUserLanguage('T1', 'U-manager', null);
    expect(await store.getUserLanguage('T1', 'U-manager')).toBeNull();
  });

  it('rejects an unsupported locale instead of persisting it', async () => {
    await expect(store.setWorkspaceLanguage('T1', 'xx' as never)).rejects.toThrow(/Unsupported locale/);
    await expect(store.setUserLanguage('T1', 'U-manager', 'xx' as never)).rejects.toThrow(/Unsupported locale/);
    await expect(store.setContentLanguage('T1', 'xx' as never)).rejects.toThrow(/Unsupported content language/);

    const config = await store.getWorkspaceConfig('T1');
    expect(config?.uiLanguage).toBeUndefined();
    expect(config?.contentLanguage).toBeUndefined();
    expect(config?.userLanguages).toBeUndefined();
  });

  it('defaults to English UI and conversation-following content', async () => {
    expect(await store.getWorkspaceLanguage('T1')).toBe('en');
    expect(await store.getContentLanguage('T1')).toBe('follow-conversation');

    await store.setContentLanguage('T1', 'ko');
    expect(await store.getContentLanguage('T1')).toBe('ko');
  });

  it('does not lose a token when a concurrent unrelated field update lands', async () => {
    await Promise.all([
      store.setUserGithubToken('T1', 'U-a', { accessToken: 'tok-a', user: githubUser }),
      store.setUserGithubToken('T1', 'U-b', { accessToken: 'tok-b', user: githubUser }),
      store.setOrganizationName('T1', 'Renamed Org'),
    ]);

    expect(await store.getUserGithubToken('T1', 'U-a')).toBe('tok-a');
    expect(await store.getUserGithubToken('T1', 'U-b')).toBe('tok-b');
    const config = await store.getWorkspaceConfig('T1');
    expect(config?.organizationName).toBe('Renamed Org');
  });
});
