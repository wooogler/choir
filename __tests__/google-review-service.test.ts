import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { REPLICA_BANNER } from 'services/google/banner';
import { exportDocMarkdown, getDocMeta } from 'services/google/drive-client';
import { getDocState, mutateDocState, writeBaseline, writeSourceSnapshot } from 'services/google/gdocs-state';
import { getWorkspaceClient } from 'services/google/google-auth-service';
import { publishReplica } from 'services/google/replica-publisher';
import { approveReview, buildReview, rejectReview } from 'services/google/review-service';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

const commitFilesWithContext = jest.fn();

jest.mock('services/google/drive-client', () => ({ getDocMeta: jest.fn(), exportDocMarkdown: jest.fn() }));
jest.mock('services/google/google-auth-service', () => ({
  getWorkspaceClient: jest.fn(),
  noteCredentialFailure: jest.fn().mockResolvedValue(false),
}));
jest.mock('services/google/replica-publisher', () => ({ publishReplica: jest.fn() }));
jest.mock('services/github', () => ({
  GithubService: { getInstance: () => ({ commitFilesWithContext }) },
}));
jest.mock('services/slack', () => ({
  getGithubRepo: jest.fn().mockResolvedValue({ owner: 'acme', repo: 'docs', branch: 'main' }),
}));
jest.mock('services/document/provenance', () => ({
  buildContextFile: jest.fn().mockResolvedValue({ path: '.choir/context/x.json.enc', content: 'enc' }),
  persistContextToMirror: jest.fn().mockResolvedValue(undefined),
}));

const mockGetMeta = getDocMeta as jest.MockedFunction<typeof getDocMeta>;
const mockExport = exportDocMarkdown as jest.MockedFunction<typeof exportDocMarkdown>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;
const mockPublish = publishReplica as jest.MockedFunction<typeof publishReplica>;

const SOURCE = '# Guide\n\nSome prose here.\n';
const BASELINE = `${REPLICA_BANNER}\n\n# Guide\n\nSome prose here.\n`;
const EDITED_EXPORT = `${REPLICA_BANNER}\n\n# Guide\n\nSome prose here, edited in Docs.\n`;

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('Google Docs review and decisions', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  const writeMirror = (content: string) => {
    const dir = path.join(tempDir, 'workspaces', 'T1', 'repo', 'docs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), content);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-review-'));
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

    writeMirror(SOURCE);
    await writeBaseline('T1', 'docs/a.md', BASELINE);
    await writeSourceSnapshot('T1', 'docs/a.md', SOURCE);
    await mutateDocState('T1', 'docs/a.md', () => ({ status: 'drifted', lastPushedVersion: '10', updatedAt: '' }));

    mockClient.mockResolvedValue({} as never);
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11', lastModifyingUser: 'someone@example.com' });
    mockExport.mockResolvedValue(EDITED_EXPORT);
    mockPublish.mockResolvedValue({ outcome: 'published' });
    commitFilesWithContext.mockResolvedValue({ commitSha: 'abc123' });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'CHOIR_DB_KEY_FILE', 'CHOIR_DATA_DIR']) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  describe('building the review', () => {
    it('proposes the edit as repository markdown and moves into review', async () => {
      const review = await buildReview('T1', 'docs/a.md');

      expect(review.status).toBe('ready');
      expect(review.before).toBe(SOURCE);
      expect(review.after).toContain('Some prose here, edited in Docs.');
      expect(review.editor).toBe('someone@example.com');
      expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('pending-review');
    });

    it('records the fences the decision will be checked against', async () => {
      await buildReview('T1', 'docs/a.md');

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.reviewedVersion).toBe('11');
      expect(state?.oursBlobSha).toHaveLength(40);
    });

    it('reports a document nobody has edited', async () => {
      mockExport.mockResolvedValue(BASELINE);

      expect((await buildReview('T1', 'docs/a.md')).status).toBe('no-change');
    });

    it('refuses to review a document that is in sync', async () => {
      await mutateDocState('T1', 'docs/a.md', () => ({ status: 'synced', updatedAt: '' }));

      expect((await buildReview('T1', 'docs/a.md')).status).toBe('not-drifted');
    });

    it('reports a lost baseline instead of proposing a guess', async () => {
      fs.rmSync(path.join(tempDir, 'workspaces', 'T1', 'state', 'gdocs-baselines'), { recursive: true, force: true });

      expect((await buildReview('T1', 'docs/a.md')).status).toBe('baseline-lost');
    });
  });

  describe('approving', () => {
    it('commits the manager text with gdocs-edit provenance and republishes', async () => {
      const review = await buildReview('T1', 'docs/a.md');

      const result = await approveReview({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        userId: 'U-manager',
        content: review.after ?? '',
      });

      expect(result.outcome).toBe('committed');
      expect(result.commitSha).toBe('abc123');

      const files = commitFilesWithContext.mock.calls[0][0].files;
      expect(files[0].path).toBe('docs/a.md');
      expect(files[1].path).toContain('.choir/context/');
      // Force, or the holding state and the now-matching hash would both skip it.
      expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });

    it('refuses when the document is not under review', async () => {
      const result = await approveReview({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        userId: 'U-manager',
        content: 'anything',
      });

      expect(result.outcome).toBe('not-pending');
      expect(commitFilesWithContext).not.toHaveBeenCalled();
    });

    it('refuses when someone committed to the file while the review was open', async () => {
      const review = await buildReview('T1', 'docs/a.md');
      // A colleague's commit lands; approving the older merge would erase it.
      writeMirror('# Guide\n\nA colleague rewrote this on GitHub.\n');

      const result = await approveReview({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        userId: 'U-manager',
        content: review.after ?? '',
      });

      expect(result.outcome).toBe('stale');
      expect(commitFilesWithContext).not.toHaveBeenCalled();
    });

    it('rebuilds the review after a stale rejection so the manager sees the new state', async () => {
      await buildReview('T1', 'docs/a.md');
      writeMirror('# Guide\n\nA colleague rewrote this on GitHub.\n');
      await writeSourceSnapshot('T1', 'docs/a.md', SOURCE);

      await approveReview({ workspaceId: 'T1', githubPath: 'docs/a.md', userId: 'U-manager', content: 'x' });

      // Still in review, with the fence refreshed against the newer blob.
      expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('pending-review');
    });

    it('only lets one of two managers approve', async () => {
      const review = await buildReview('T1', 'docs/a.md');
      const approve = () =>
        approveReview({
          workspaceId: 'T1',
          githubPath: 'docs/a.md',
          userId: 'U-manager',
          content: review.after ?? '',
        });

      const [first, second] = await Promise.all([approve(), approve()]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(['committed', 'not-pending']);
      expect(commitFilesWithContext).toHaveBeenCalledTimes(1);
    });

    it('commits images as binary rather than base64 text', async () => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('body'),
      ]).toString('base64');
      mockExport.mockResolvedValue(`${EDITED_EXPORT}\n[image1]: <data:image/png;base64,${png}>\n`);

      const review = await buildReview('T1', 'docs/a.md');
      await approveReview({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        userId: 'U-manager',
        content: review.after ?? '',
      });

      const files = commitFilesWithContext.mock.calls[0][0].files;
      const asset = files.find((file: { path: string }) => file.path.startsWith('assets/'));
      expect(asset.encoding).toBe('base64');
      expect(asset.path).toMatch(/\.png$/);
    });
  });

  describe('rejecting', () => {
    it('restores the replica from the repository', async () => {
      await buildReview('T1', 'docs/a.md');

      const result = await rejectReview('T1', 'docs/a.md');

      expect(result.outcome).toBe('restored');
      expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ force: true, markdown: SOURCE }));
      expect(commitFilesWithContext).not.toHaveBeenCalled();
    });

    it('refuses to restore over an edit made after the review was rendered', async () => {
      await buildReview('T1', 'docs/a.md');
      // Polling runs every few minutes, so this window always exists; restoring
      // would destroy text no manager has seen.
      mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '12' });

      const result = await rejectReview('T1', 'docs/a.md');

      expect(result.outcome).toBe('stale');
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('refuses when the document is not under review', async () => {
      expect((await rejectReview('T1', 'docs/a.md')).outcome).toBe('not-pending');
    });
  });
});
