import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { REPLICA_BANNER } from 'services/google/banner';
import { checkAndHealDocument, checkDocumentForDrift, sweepWorkspace } from 'services/google/drift-detector';
import { exportDocMarkdown, getDocMeta } from 'services/google/drive-client';
import { getDocState, mutateDocState, writeBaseline } from 'services/google/gdocs-state';
import { getWorkspaceClient } from 'services/google/google-auth-service';
import { publishReplica } from 'services/google/replica-publisher';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

jest.mock('services/google/drive-client', () => ({
  getDocMeta: jest.fn(),
  exportDocMarkdown: jest.fn(),
}));
jest.mock('services/google/google-auth-service', () => ({
  getWorkspaceClient: jest.fn(),
  noteCredentialFailure: jest.fn().mockResolvedValue(false),
}));
jest.mock('services/google/replica-publisher', () => ({ publishReplica: jest.fn() }));

const mockGetMeta = getDocMeta as jest.MockedFunction<typeof getDocMeta>;
const mockExport = exportDocMarkdown as jest.MockedFunction<typeof exportDocMarkdown>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;
const mockPublish = publishReplica as jest.MockedFunction<typeof publishReplica>;

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const BASELINE = `${REPLICA_BANNER}\n\n# Title\n\nBody text.\n`;

describe('Google Docs drift detection', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-drift-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://example.com/a',
      linkedBy: 'U-manager',
      mode: 'replica',
    });

    const repoDir = path.join(tempDir, 'workspaces', 'T1', 'repo', 'docs');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'a.md'), '# Title\n\nBody text.\n');

    await writeBaseline('T1', 'docs/a.md', BASELINE);
    await mutateDocState('T1', 'docs/a.md', () => ({
      status: 'synced',
      lastPushedVersion: '10',
      updatedAt: '',
    }));

    mockClient.mockResolvedValue({} as never);
    mockPublish.mockResolvedValue({ outcome: 'published' });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'CHOIR_DB_KEY_FILE', 'CHOIR_DATA_DIR']) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('does nothing when the version has not moved', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '10' });

    const result = await checkDocumentForDrift('T1', 'docs/a.md');

    expect(result.outcome).toBe('unchanged');
    // The cheap path must not pay for an export.
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('absorbs a version bump that did not change the text', async () => {
    // Renaming the file bumps version (measured), and must not read as an edit.
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockExport.mockResolvedValue(BASELINE);

    const result = await checkDocumentForDrift('T1', 'docs/a.md');

    expect(result.outcome).toBe('metadata-only');
    const state = await getDocState('T1', 'docs/a.md');
    expect(state?.status).toBe('synced');
    expect(state?.lastPushedVersion).toBe('11');
  });

  it('flags a human edit and records the newest version it has seen', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11', lastModifyingUser: 'someone@example.com' });
    mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nBody text with an addition.\n`);

    const result = await checkDocumentForDrift('T1', 'docs/a.md');

    expect(result.outcome).toBe('drifted');
    expect(result.lastModifyingUser).toBe('someone@example.com');
    const state = await getDocState('T1', 'docs/a.md');
    expect(state?.status).toBe('drifted');
    expect(state?.latestVersion).toBe('11');
    // The decision fence is set when a review is rendered, not by the poller.
    expect(state?.reviewedVersion).toBeUndefined();
    expect(state?.driftDetectedAt).toBeTruthy();
  });

  it('ignores the banner itself when comparing', async () => {
    // Otherwise a wording change in the banner would drift every document.
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockExport.mockResolvedValue('*This document is a read-only replica — reworded.*\n\n# Title\n\nBody text.\n');

    expect((await checkDocumentForDrift('T1', 'docs/a.md')).outcome).toBe('metadata-only');
  });

  it('restores a deleted banner instead of asking a manager to review it', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockExport.mockResolvedValue('# Title\n\nBody text.\n');

    const result = await checkAndHealDocument('T1', 'docs/a.md');

    expect(result.outcome).toBe('banner-restored');
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('completes the heal without deadlocking on the document lock', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockExport.mockResolvedValue('# Title\n\nBody text.\n');

    // Publishing takes the same per-document key the check holds, so healing has
    // to happen after the check returns. A regression here hangs the poller.
    const settled = await Promise.race([
      checkAndHealDocument('T1', 'docs/a.md').then((r) => r.outcome),
      new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 1000)),
    ]);

    expect(settled).toBe('banner-restored');
  });

  it('reports a missing baseline rather than guessing', async () => {
    fs.rmSync(path.join(tempDir, 'workspaces', 'T1', 'state', 'gdocs-baselines'), { recursive: true, force: true });
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });

    const result = await checkDocumentForDrift('T1', 'docs/a.md');

    expect(result.outcome).toBe('baseline-lost');
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('baseline-lost');
    // Republishing to re-establish a baseline would destroy an unseen edit.
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('marks a trashed document as an error', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11', trashed: true });

    expect((await checkDocumentForDrift('T1', 'docs/a.md')).outcome).toBe('trashed');
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('error');
  });

  it('stays quiet on a document already flagged and untouched since', async () => {
    await mutateDocState('T1', 'docs/a.md', (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'drifted',
      latestVersion: '11',
      updatedAt: '',
    }));
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });

    expect((await checkDocumentForDrift('T1', 'docs/a.md')).outcome).toBe('unchanged');
  });

  it('reports a further edit made during review', async () => {
    await mutateDocState('T1', 'docs/a.md', (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'pending-review',
      reviewedVersion: '11',
      updatedAt: '',
    }));
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '12' });
    mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nEdited again.\n`);

    const result = await checkDocumentForDrift('T1', 'docs/a.md');

    expect(result.outcome).toBe('drifted-again');
    expect((await getDocState('T1', 'docs/a.md'))?.status).toBe('pending-review');
    // Only the "newest seen" marker moves. Advancing reviewedVersion here would
    // carry the decision fence past an edit the manager never saw, and approving
    // would then destroy it.
    expect((await getDocState('T1', 'docs/a.md'))?.latestVersion).toBe('12');
    expect((await getDocState('T1', 'docs/a.md'))?.reviewedVersion).toBe('11');
  });

  it('releases a document whose edit was undone in the Doc', async () => {
    await mutateDocState('T1', 'docs/a.md', (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'drifted',
      driftDetectedAt: 'earlier',
      latestVersion: '11',
      updatedAt: '',
    }));
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '12' });
    mockExport.mockResolvedValue(BASELINE);

    await checkDocumentForDrift('T1', 'docs/a.md');

    // Otherwise the document sits in a holding state with nothing to review,
    // silently freezing every future GitHub push to it.
    const state = await getDocState('T1', 'docs/a.md');
    expect(state?.status).toBe('synced');
    expect(state?.driftDetectedAt).toBeUndefined();
  });

  it('marks whitespace-only differences as normalization', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nBody  text.\n\n`);

    const result = await checkDocumentForDrift('T1', 'docs/a.md');

    expect(result.outcome).toBe('drifted');
    expect(result.normalizationOnly).toBe(true);
  });

  it('does not call a real edit normalization', async () => {
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nBody text plus a sentence.\n`);

    expect((await checkDocumentForDrift('T1', 'docs/a.md')).normalizationOnly).toBe(false);
  });

  describe('sweeping a workspace', () => {
    const linkDocs = async (count: number) => {
      const repoDir = path.join(tempDir, 'workspaces', 'T1', 'repo', 'docs');
      for (let index = 0; index < count; index += 1) {
        const docPath = `docs/doc-${index}.md`;
        // The mirror file has to exist: a mapping whose source is gone is
        // orphaned, and never reaches the drift comparison.
        fs.writeFileSync(path.join(repoDir, `doc-${index}.md`), '# Title\n\nBody text.\n');
        await store.setGoogleDocMapping('T1', docPath, {
          fileId: `file-${index}`,
          webViewLink: `https://example.com/${index}`,
          linkedBy: 'U-manager',
          mode: 'replica',
        });
        await writeBaseline('T1', docPath, BASELINE);
        await mutateDocState('T1', docPath, () => ({ status: 'synced', lastPushedVersion: '10', updatedAt: '' }));
      }
    };

    it('raises the circuit breaker when many documents drift with only normalization changes', async () => {
      // The shape of Google changing its export serializer under us: every
      // document at once, none of them meaningfully edited.
      await linkDocs(6);
      mockGetMeta.mockResolvedValue({ fileId: 'file-x', version: '11' });
      mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nBody  text.\n\n`);

      const result = await sweepWorkspace('T1');

      expect(result.drifted.length).toBeGreaterThanOrEqual(5);
      expect(result.massDriftSuspected).toBe(true);
    });

    it('does not raise it for real edits, however many', async () => {
      await linkDocs(6);
      mockGetMeta.mockResolvedValue({ fileId: 'file-x', version: '11' });
      mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nSomebody rewrote this entirely.\n`);

      const result = await sweepWorkspace('T1');

      expect(result.massDriftSuspected).toBe(false);
    });

    it('does not raise it below the threshold', async () => {
      await linkDocs(2);
      mockGetMeta.mockResolvedValue({ fileId: 'file-x', version: '11' });
      mockExport.mockResolvedValue(`${REPLICA_BANNER}\n\n# Title\n\nBody  text.\n\n`);

      const result = await sweepWorkspace('T1');

      expect(result.massDriftSuspected).toBe(false);
    });

    it('stops sweeping a workspace whose credential is gone', async () => {
      await linkDocs(4);
      mockClient.mockResolvedValue(null);

      const result = await sweepWorkspace('T1');

      expect(result.checked).toBe(1);
      expect(mockGetMeta).not.toHaveBeenCalled();
    });
  });
});

describe('a replica whose GitHub source is gone', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-orphan-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig({
      workspaceId: 'T1',
      managers: ['U-manager'],
      choirUsers: ['U-manager'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await store.setGoogleDocMapping('T1', 'docs/deleted.md', {
      fileId: 'file-x',
      webViewLink: 'https://example.com/x',
      linkedBy: 'U-manager',
      mode: 'replica',
    });
    fs.mkdirSync(path.join(tempDir, 'workspaces', 'T1', 'repo'), { recursive: true });

    mockClient.mockResolvedValue({} as never);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ['DATABASE_URL', 'CHOIR_DB_KEY_FILE', 'CHOIR_DATA_DIR']) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('marks the replica orphaned without calling Drive', async () => {
    const result = await checkDocumentForDrift('T1', 'docs/deleted.md');

    expect(result.outcome).toBe('orphaned');
    expect((await getDocState('T1', 'docs/deleted.md'))?.status).toBe('orphaned');
    // Nothing can be published or compared, so there is no reason to spend a call.
    expect(mockGetMeta).not.toHaveBeenCalled();
  });

  it('stays orphaned without rewriting the state on every poll', async () => {
    await checkDocumentForDrift('T1', 'docs/deleted.md');
    const first = await getDocState('T1', 'docs/deleted.md');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await checkDocumentForDrift('T1', 'docs/deleted.md');

    expect((await getDocState('T1', 'docs/deleted.md'))?.updatedAt).toBe(first?.updatedAt);
  });
});
