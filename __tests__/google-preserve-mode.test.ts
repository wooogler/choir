import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { exportDocMarkdown, getDocMeta, replaceDocContent, setDocDescription } from 'services/google/drive-client';
import { getDocState, mutateDocState, readBaseline, readSourceSnapshot } from 'services/google/gdocs-state';
import { getWorkspaceClient, noteCredentialFailure } from 'services/google/google-auth-service';
import { publishReplica, seedReplica } from 'services/google/replica-publisher';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

/**
 * `preserve` documents are the ones that were somebody's document before they
 * were CHOIR's, and the promise made about them is narrow enough to test
 * directly: their body is never written.
 *
 * Almost every assertion here is therefore the same assertion —
 * `replaceDocContent` was not called — approached from a different direction,
 * because the ways a document gets published are many and it only takes one of
 * them to flatten the thing.
 */

jest.mock('services/google/drive-client', () => ({
  replaceDocContent: jest.fn(),
  exportDocMarkdown: jest.fn(),
  getDocMeta: jest.fn(),
  setDocDescription: jest.fn(),
}));

jest.mock('services/google/google-auth-service', () => ({
  getWorkspaceClient: jest.fn(),
  noteCredentialFailure: jest.fn().mockResolvedValue(false),
}));

const mockReplace = replaceDocContent as jest.MockedFunction<typeof replaceDocContent>;
const mockExport = exportDocMarkdown as jest.MockedFunction<typeof exportDocMarkdown>;
const mockGetMeta = getDocMeta as jest.MockedFunction<typeof getDocMeta>;
const mockDescribe = setDocDescription as jest.MockedFunction<typeof setDocDescription>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;
const mockNoteFailure = noteCredentialFailure as jest.MockedFunction<typeof noteCredentialFailure>;

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** What a handbook-ish document exports as, and the markdown it extracts to. */
const DOC_EXPORT = '# Handbook\n\nWelcome to the lab\\.\n';
const DOC_AS_REPOSITORY = '# Handbook\n\nWelcome to the lab.\n';

describe('Google Docs preserve mode', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  const link = async (mode: 'replica' | 'preserve' | 'unset') => {
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://docs.google.com/document/d/file-a/edit',
      linkedBy: 'U-manager',
      mode: mode === 'unset' ? 'replica' : mode,
    });
    if (mode === 'unset') {
      // Reach past the setter, which now requires a mode, to reproduce a mapping
      // written before the field existed.
      await store.setGoogleDocMode('T1', 'replica');
      const config = await store.getWorkspaceConfig('T1');
      const docs = config?.google?.docs;
      if (docs) {
        Reflect.deleteProperty(docs['docs/a.md'], 'mode');
        await store.saveWorkspaceConfig(config as WorkspaceConfig);
      }
    }
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-preserve-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));

    mockClient.mockResolvedValue({} as never);
    mockNoteFailure.mockResolvedValue(false);
    mockExport.mockResolvedValue(DOC_EXPORT);
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockDescribe.mockResolvedValue({ fileId: 'file-a', version: '10' });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  describe('seeding, which is how a preserved document gets its bookkeeping', () => {
    it('records the baseline pair without writing to the document', async () => {
      await link('preserve');

      const result = await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
      });

      expect(result.outcome).toBe('seeded');
      expect(mockReplace).not.toHaveBeenCalled();
      expect(await readBaseline('T1', 'docs/a.md')).toBe(DOC_EXPORT);
      expect(await readSourceSnapshot('T1', 'docs/a.md')).toBe(DOC_AS_REPOSITORY);

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.status).toBe('synced');
      expect(state?.lastPushedVersion).toBe('11');
    });

    it('stamps the link notice on the file metadata rather than into the body', async () => {
      await link('preserve');

      await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
        description: 'Linked to CHOIR.',
      });

      expect(mockDescribe).toHaveBeenCalledWith(expect.anything(), 'file-a', 'Linked to CHOIR.');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('keeps the seed when the description stamp fails, since it is decoration', async () => {
      await link('preserve');
      mockDescribe.mockRejectedValue(new Error('insufficient permissions'));

      const result = await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
        description: 'Linked to CHOIR.',
      });

      expect(result.outcome).toBe('seeded');
      expect(await readBaseline('T1', 'docs/a.md')).toBe(DOC_EXPORT);
    });

    it('reports drift, and keeps the honest baseline, when somebody typed while we read', async () => {
      await link('preserve');
      // The export taken after the read no longer matches the one the repository
      // content came from.
      mockExport.mockResolvedValue(`${DOC_EXPORT}\nA sentence somebody just added.\n`);

      const result = await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
      });

      expect(result.outcome).toBe('seeded-drifted');
      // Still the export the committed markdown was derived from — the pair has
      // to stay honest or the delta path cannot express the human's edit.
      expect(await readBaseline('T1', 'docs/a.md')).toBe(DOC_EXPORT);

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.status).toBe('drifted');
      expect(state?.latestVersion).toBe('11');
    });

    it('refuses to seed a document that is not linked', async () => {
      const result = await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
      });

      expect(result.outcome).toBe('not-linked');
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('publishing, which must never reach the document body', () => {
    beforeEach(async () => {
      await link('preserve');
      await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
      });
      jest.clearAllMocks();
      mockClient.mockResolvedValue({} as never);
      mockNoteFailure.mockResolvedValue(false);
      mockExport.mockResolvedValue(DOC_EXPORT);
      mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    });

    it('holds a GitHub change for a person to apply instead of writing it', async () => {
      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: `${DOC_AS_REPOSITORY}\n## A new section\n`,
      });

      expect(result.outcome).toBe('held-for-manual');
      expect(mockReplace).not.toHaveBeenCalled();

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.pendingManual?.targetHash).toEqual(expect.any(String));
    });

    it('does not write even when forced, which is what approve and reject pass', async () => {
      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: `${DOC_AS_REPOSITORY}\n## Approved wording\n`,
        force: true,
      });

      expect(mockReplace).not.toHaveBeenCalled();
      expect(['held-for-manual', 'published']).toContain(result.outcome);
    });

    it('re-establishes the baseline from the document after a decision', async () => {
      // The document has moved on: this is what approve sees after a human edit
      // was reviewed and committed.
      const edited = '# Handbook\n\nWelcome to the lab\\.\n\nA reviewed paragraph\\.\n';
      mockExport.mockResolvedValue(edited);
      mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '14' });

      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: '# Handbook\n\nWelcome to the lab.\n\nA reviewed paragraph.\n',
        force: true,
      });

      expect(mockReplace).not.toHaveBeenCalled();
      expect(result.outcome).toBe('published');
      expect(result.detail).toBe('preserve:reseeded');
      expect(await readBaseline('T1', 'docs/a.md')).toBe(edited);

      const state = await getDocState('T1', 'docs/a.md');
      // Released, or the manager would be asked to approve the same edit forever.
      expect(state?.status).toBe('synced');
      expect(state?.lastPushedVersion).toBe('14');
    });

    it('cards the leftover when a decision left the document short of GitHub', async () => {
      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        // The manager rewrote this in the review screen, so the document does
        // not hold it and somebody has to put it there.
        markdown: '# Handbook\n\nWelcome to the lab.\n\nWording the manager changed.\n',
        force: true,
      });

      expect(mockReplace).not.toHaveBeenCalled();
      expect(result.outcome).toBe('held-for-manual');

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.status).toBe('synced');
      expect(state?.pendingManual).toBeDefined();
    });

    it('does not swallow a paragraph typed after the manager reviewed', async () => {
      // Put the document into the state a decision leaves behind: a review was
      // rendered against version 11.
      await mutateDocState('T1', 'docs/a.md', (existing) => ({
        ...(existing ?? { status: 'synced', updatedAt: '' }),
        status: 'applying',
        reviewedVersion: '11',
        updatedAt: '',
      }));

      // Somebody typed between the fence check and this write, so the document
      // is at a version the manager never saw.
      mockExport.mockResolvedValue(`${DOC_EXPORT}\nTyped while the decision was in flight.\n`);
      mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '12' });

      await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        force: true,
      });

      const state = await getDocState('T1', 'docs/a.md');
      // Adopting it as synced would leave that sentence in the document and
      // invisible to review for good.
      expect(state?.status).toBe('drifted');
      expect(state?.latestVersion).toBe('12');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('retires a stale request once the document has caught up', async () => {
      // A change was held for someone to apply...
      await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: `${DOC_AS_REPOSITORY}\n## A new section\n`,
      });
      expect((await getDocState('T1', 'docs/a.md'))?.pendingManual).toBeDefined();

      // ...and then somebody applied it, so the document now exports it.
      const applied = `${DOC_EXPORT}\n## A new section\n`;
      mockExport.mockResolvedValue(applied);
      await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: `${DOC_AS_REPOSITORY}\n## A new section\n`,
        force: true,
      });

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.pendingManual).toBeUndefined();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('says nothing when the document already holds the change', async () => {
      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
      });

      expect(result.outcome).toBe('unchanged');
      expect(mockReplace).not.toHaveBeenCalled();

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.pendingManual).toBeUndefined();
    });

    it('waits while a human edit is already in front of a manager', async () => {
      mockExport.mockResolvedValue(`${DOC_EXPORT}\nSomething a person wrote.\n`);
      // Put the document into a holding state the way the poller would.
      await seedReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: DOC_AS_REPOSITORY,
        baseline: DOC_EXPORT,
      });
      expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('drifted');

      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: `${DOC_AS_REPOSITORY}\n## Later\n`,
      });

      expect(result.outcome).toBe('held');
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('a mapping with no mode at all', () => {
    it('refuses to publish rather than guessing which kind of document it is', async () => {
      await link('unset');

      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: '# Anything',
      });

      expect(result.outcome).toBe('unknown-mode');
      expect(mockReplace).not.toHaveBeenCalled();
      expect((await getDocState('T1', 'docs/a.md'))?.error).toMatch(/backfill/i);
    });

    it('refuses when forced too, since force bypasses content guards and not this one', async () => {
      await link('unset');

      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: '# Anything',
        force: true,
      });

      expect(result.outcome).toBe('unknown-mode');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('publishes normally once the backfill has stamped it', async () => {
      await link('unset');
      mockReplace.mockResolvedValue({ fileId: 'file-a', version: '11' });

      const stamped = await store.setGoogleDocMode('T1', 'replica', { onlyIfUnset: true });
      expect(stamped).toEqual(['docs/a.md']);

      const result = await publishReplica({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        markdown: '# Anything',
      });

      expect(result.outcome).toBe('published');
      expect(mockReplace).toHaveBeenCalled();
    });

    it('leaves a mode that is already set alone', async () => {
      await link('preserve');

      expect(await store.setGoogleDocMode('T1', 'replica', { onlyIfUnset: true })).toEqual([]);
      expect((await store.getGoogleDocMapping('T1', 'docs/a.md'))?.mode).toBe('preserve');
    });
  });
});
