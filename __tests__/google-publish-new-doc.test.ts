import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { createDocFromMarkdown, shareByLink } from 'services/google/drive-client';
import { getWorkspaceClient } from 'services/google/google-auth-service';
import { docNameFor, publishAsNewDoc } from 'services/google/publish-new-doc';
import { publishReplica } from 'services/google/replica-publisher';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

jest.mock('services/google/drive-client', () => ({
  createDocFromMarkdown: jest.fn(),
  shareByLink: jest.fn(),
}));
jest.mock('services/google/replica-publisher', () => ({ publishReplica: jest.fn() }));
jest.mock('services/google/google-auth-service', () => ({ getWorkspaceClient: jest.fn() }));

const mockCreate = createDocFromMarkdown as jest.MockedFunction<typeof createDocFromMarkdown>;
const mockShare = shareByLink as jest.MockedFunction<typeof shareByLink>;
const mockPublish = publishReplica as jest.MockedFunction<typeof publishReplica>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;

/**
 * Publishing a repository document as a new Google Doc. What matters: the Doc
 * is created before anything is stored, linked as a replica, and then handed to
 * the ordinary publisher; a path that already has a Doc never reaches Drive;
 * and a sharing failure is reported without undoing a correct link.
 */

function baseConfig(workspaceId: string): WorkspaceConfig {
  return {
    workspaceId,
    githubRepo: { owner: 'o', repo: 'r', branch: 'main', connectedBy: 'U-manager', connectedAt: new Date() },
  } as unknown as WorkspaceConfig;
}

describe('publishAsNewDoc', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-publish-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));

    const repoRoot = path.join(tempDir, 'workspaces', 'T1', 'repo', 'docs');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'a.md'), '# Onboarding Guide\n\nWelcome.\n');

    mockClient.mockResolvedValue({ getAccessToken: async () => ({ token: 'ya29.access' }) } as never);
    mockCreate.mockResolvedValue({
      fileId: 'new-doc',
      webViewLink: 'https://docs.google.com/document/d/new-doc/edit',
    });
    mockShare.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue({ outcome: 'published' });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'CHOIR_DB_KEY_FILE', 'CHOIR_DATA_DIR']) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('creates the Doc, shares it, links it as a replica and publishes with force', async () => {
    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager' });

    expect(result).toMatchObject({
      outcome: 'created',
      fileId: 'new-doc',
      webViewLink: 'https://docs.google.com/document/d/new-doc/edit',
      published: 'published',
      shared: true,
    });

    // Named after the document's own title, and seeded with its text so the
    // Doc is never seen empty.
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), {
      name: 'Onboarding Guide',
      markdown: '# Onboarding Guide\n\nWelcome.\n',
    });
    expect(mockShare).toHaveBeenCalledWith(expect.anything(), 'new-doc');

    const mapping = await store.getGoogleDocMapping('T1', 'docs/a.md');
    expect(mapping).toMatchObject({ fileId: 'new-doc', linkedBy: 'U-manager', mode: 'replica' });

    // Force, because a fresh mapping has no recorded hash or state and this
    // write is what records the baseline.
    expect(mockPublish).toHaveBeenCalledWith({
      workspaceId: 'T1',
      githubPath: 'docs/a.md',
      markdown: '# Onboarding Guide\n\nWelcome.\n',
      force: true,
    });
  });

  it('refuses a path that already has a Doc without touching Drive', async () => {
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'existing',
      webViewLink: 'https://docs.google.com/document/d/existing/edit',
      linkedBy: 'U-other',
      mode: 'preserve',
    });

    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager' });

    expect(result.outcome).toBe('already-linked');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect((await store.getGoogleDocMapping('T1', 'docs/a.md'))?.fileId).toBe('existing');
  });

  it('refuses a path that is not in the mirror', async () => {
    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/nope.md', userId: 'U-manager' });

    expect(result.outcome).toBe('missing-in-repo');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('asks for a Google connection before creating anything', async () => {
    mockClient.mockResolvedValue(null as never);

    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager' });

    expect(result.outcome).toBe('not-connected');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('reports a sharing failure but keeps the Doc created and linked', async () => {
    mockShare.mockRejectedValue(new Error('permissions denied'));

    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager' });

    expect(result).toMatchObject({ outcome: 'created', shared: false, published: 'published' });
    expect((await store.getGoogleDocMapping('T1', 'docs/a.md'))?.fileId).toBe('new-doc');
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('reports a Drive failure and stores nothing', async () => {
    mockCreate.mockRejectedValue(new Error('quota exceeded'));

    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager' });

    expect(result).toMatchObject({ outcome: 'failed', detail: 'quota exceeded' });
    expect(await store.getGoogleDocMapping('T1', 'docs/a.md')).toBeNull();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('falls back to a Drive-provided URL shape when Drive returns no link', async () => {
    mockCreate.mockResolvedValue({ fileId: 'new-doc' });

    const result = await publishAsNewDoc({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager' });

    expect(result.webViewLink).toBe('https://docs.google.com/document/d/new-doc/edit');
  });
});

describe('docNameFor', () => {
  it('uses the first heading when there is one', () => {
    expect(docNameFor('docs/a.md', '# Onboarding Guide\n\ntext')).toBe('Onboarding Guide');
    expect(docNameFor('docs/a.md', 'intro\n\n# Later Heading #\n')).toBe('Later Heading');
  });

  it('falls back to the file name without its extension', () => {
    expect(docNameFor('docs/team-handbook.md', 'no heading here')).toBe('team-handbook');
    expect(docNameFor('docs/README.MD', '## only a subheading')).toBe('README');
  });
});
