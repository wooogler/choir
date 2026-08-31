import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { exportDocMarkdown, getDocMeta, replaceDocContent } from 'services/google/drive-client';
import { getDocState, mutateDocState, readBaseline } from 'services/google/gdocs-state';
import { getWorkspaceClient, noteCredentialFailure } from 'services/google/google-auth-service';
import { publishLinkedReplicas, publishReplica } from 'services/google/replica-publisher';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

jest.mock('services/google/drive-client', () => ({
  replaceDocContent: jest.fn(),
  exportDocMarkdown: jest.fn(),
  getDocMeta: jest.fn(),
}));

jest.mock('services/google/google-auth-service', () => ({
  getWorkspaceClient: jest.fn(),
  noteCredentialFailure: jest.fn().mockResolvedValue(false),
}));

const mockReplace = replaceDocContent as jest.MockedFunction<typeof replaceDocContent>;
const mockExport = exportDocMarkdown as jest.MockedFunction<typeof exportDocMarkdown>;
const mockGetMeta = getDocMeta as jest.MockedFunction<typeof getDocMeta>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;
const mockNoteFailure = noteCredentialFailure as jest.MockedFunction<typeof noteCredentialFailure>;

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** A Drive that accepts the write and reports a stable version on readback. */
function driveBehavesNormally(version = '7', exported = 'exported markdown') {
  mockReplace.mockResolvedValue({ fileId: 'file-a', version });
  mockExport.mockResolvedValue(exported);
  mockGetMeta.mockResolvedValue({ fileId: 'file-a', version });
}

describe('Google Docs replica publisher', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-pub-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://docs.google.com/document/d/file-a/edit',
      linkedBy: 'U-manager',
    });

    mockClient.mockResolvedValue({} as never);
    mockNoteFailure.mockResolvedValue(false);
    driveBehavesNormally();
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  it('publishes, stores the readback as the baseline, and records the fenced version', async () => {
    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    expect(result.outcome).toBe('published');
    expect(await readBaseline('T1', 'docs/a.md')).toBe('exported markdown');

    const state = await getDocState('T1', 'docs/a.md');
    expect(state?.status).toBe('synced');
    expect(state?.lastPushedVersion).toBe('7');
  });

  it('sends the banner ahead of the document body', async () => {
    await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    const sent = mockReplace.mock.calls[0][2];
    expect(sent).toMatch(/^\*This document is a read-only replica/);
    expect(sent).toContain('# Title');
  });

  it('skips a republish of byte-identical content', async () => {
    await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });
    mockReplace.mockClear();

    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    expect(result.outcome).toBe('unchanged');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('publishes again when the content changes', async () => {
    await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });
    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title\n\nMore' });

    expect(result.outcome).toBe('published');
  });

  it.each(['drifted', 'pending-review', 'baseline-lost', 'orphaned'] as const)(
    'holds back a push while the document is %s',
    async (status) => {
      await mutateDocState('T1', 'docs/a.md', () => ({ status, updatedAt: '' }));

      const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Changed' });

      // Publishing here would destroy an edit a human made and nobody has reviewed.
      expect(result.outcome).toBe('held');
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it('force bypasses the holding state, which is how a rejection restores the replica', async () => {
    await mutateDocState('T1', 'docs/a.md', () => ({ status: 'pending-review', updatedAt: '' }));

    const result = await publishReplica({
      workspaceId: 'T1',
      githubPath: 'docs/a.md',
      markdown: '# Title',
      force: true,
    });

    expect(result.outcome).toBe('published');
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('synced');
  });

  it('force bypasses the unchanged-content guard too', async () => {
    // On a rejection the GitHub side has not moved, so a hash-guarded push would
    // no-op and leave the rejected edits in the Doc.
    await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });
    mockReplace.mockClear();

    const result = await publishReplica({
      workspaceId: 'T1',
      githubPath: 'docs/a.md',
      markdown: '# Title',
      force: true,
    });

    expect(result.outcome).toBe('published');
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('clears the review fences once a document is back in sync', async () => {
    await mutateDocState('T1', 'docs/a.md', () => ({
      status: 'pending-review',
      reviewedVersion: '3',
      oursBlobSha: 'sha-old',
      reviewCards: [{ managerId: 'U-manager', channel: 'D1', ts: '1.0' }],
      driftDetectedAt: 'earlier',
      updatedAt: '',
    }));

    await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title', force: true });

    const state = await getDocState('T1', 'docs/a.md');
    expect(state?.reviewedVersion).toBeUndefined();
    expect(state?.oursBlobSha).toBeUndefined();
    expect(state?.reviewCards).toBeUndefined();
    expect(state?.driftDetectedAt).toBeUndefined();
  });

  it('treats a version change between write and readback as drift and stores no baseline', async () => {
    // A human edit landing inside that window would otherwise be exported into
    // the baseline, after which the poller compares their edit against itself and
    // the change is never reported.
    mockReplace.mockResolvedValue({ fileId: 'file-a', version: '7' });
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '8' });

    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    expect(result.detail).toBe('raced-into-drift');
    expect(await readBaseline('T1', 'docs/a.md')).toBeNull();
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('drifted');
  });

  it('treats a missing version on the update response as unfenced', async () => {
    mockReplace.mockResolvedValue({ fileId: 'file-a' });
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '7' });

    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    expect(result.detail).toBe('raced-into-drift');
    expect(await readBaseline('T1', 'docs/a.md')).toBeNull();
  });

  it('reports an unlinked document without calling Drive', async () => {
    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/unlinked.md', markdown: '# x' });

    expect(result.outcome).toBe('not-linked');
    expect(mockClient).not.toHaveBeenCalled();
  });

  it('reports a workspace with no usable credential', async () => {
    mockClient.mockResolvedValue(null);

    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# x' });

    expect(result.outcome).toBe('not-connected');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('records the error and keeps the previous state on a Drive failure', async () => {
    mockReplace.mockRejectedValue(new Error('quota exceeded'));

    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    expect(result.outcome).toBe('failed');
    expect((await getDocState('T1', 'docs/a.md'))?.error).toContain('quota exceeded');
  });

  it('retries on the next trigger after a failure, since no hash was recorded', async () => {
    mockReplace.mockRejectedValueOnce(new Error('transient'));
    await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    driveBehavesNormally();
    const result = await publishReplica({ workspaceId: 'T1', githubPath: 'docs/a.md', markdown: '# Title' });

    expect(result.outcome).toBe('published');
  });

  describe('publishing a whole file set', () => {
    beforeEach(async () => {
      await store.setGoogleDocMapping('T1', 'docs/b.md', {
        fileId: 'file-b',
        webViewLink: 'https://example.com/b',
        linkedBy: 'U-manager',
      });
    });

    it('publishes only the linked documents out of a full sync', async () => {
      const result = await publishLinkedReplicas('T1', [
        { path: 'docs/a.md', content: '# A' },
        { path: 'docs/b.md', content: '# B' },
        { path: 'docs/unlinked.md', content: '# C' },
      ]);

      expect(result.published.sort()).toEqual(['docs/a.md', 'docs/b.md']);
      expect(mockReplace).toHaveBeenCalledTimes(2);
    });

    it('separates held documents from published ones', async () => {
      await mutateDocState('T1', 'docs/b.md', () => ({ status: 'drifted', updatedAt: '' }));

      const result = await publishLinkedReplicas('T1', [
        { path: 'docs/a.md', content: '# A' },
        { path: 'docs/b.md', content: '# B' },
      ]);

      expect(result.published).toEqual(['docs/a.md']);
      expect(result.held).toEqual(['docs/b.md']);
    });

    it('stops early when the credential is gone rather than retrying per document', async () => {
      mockClient.mockResolvedValue(null);

      await publishLinkedReplicas('T1', [
        { path: 'docs/a.md', content: '# A' },
        { path: 'docs/b.md', content: '# B' },
      ]);

      expect(mockClient).toHaveBeenCalledTimes(1);
    });

    it('does nothing for a workspace with no replicas at all', async () => {
      await store.saveWorkspaceConfig(baseConfig('T2'));

      const result = await publishLinkedReplicas('T2', [{ path: 'docs/a.md', content: '# A' }]);

      expect(result).toEqual({ published: [], held: [], failed: [] });
      expect(mockClient).not.toHaveBeenCalled();
    });
  });
});
