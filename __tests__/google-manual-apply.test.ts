import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { exportDocMarkdown, getDocMeta, replaceDocContent, setDocDescription } from 'services/google/drive-client';
import { getDocState, mutateDocState } from 'services/google/gdocs-state';
import { getWorkspaceClient } from 'services/google/google-auth-service';
import {
  buildDiffPreview,
  confirmManualApply,
  declineManualApply,
  documentsAwaitingNotice,
  notifyManualApply,
  retireManualCards,
} from 'services/google/manual-apply';
import { getManagers, isManager } from 'services/slack/user-management';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';
import { createT } from '../src/i18n';

/**
 * The manual-apply card is the whole delivery mechanism for a change CHOIR could
 * not make itself. Divergence between the document and the repository is an
 * accepted outcome here; *silent* divergence is the failure, so most of what is
 * checked below is that somebody is told, and that nothing is marked done
 * without the document actually having caught up.
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

jest.mock('services/slack/user-management', () => ({
  isManager: jest.fn(),
  getManagers: jest.fn(),
}));

const mockReplace = replaceDocContent as jest.MockedFunction<typeof replaceDocContent>;
const mockExport = exportDocMarkdown as jest.MockedFunction<typeof exportDocMarkdown>;
const mockGetMeta = getDocMeta as jest.MockedFunction<typeof getDocMeta>;
const mockDescribe = setDocDescription as jest.MockedFunction<typeof setDocDescription>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;
const mockIsManager = isManager as jest.MockedFunction<typeof isManager>;
const mockGetManagers = getManagers as jest.MockedFunction<typeof getManagers>;

const t = createT('en');

const DOC_EXPORT = '# Handbook\n\nWelcome to the lab\\.\n';
const DOC_AS_REPOSITORY = '# Handbook\n\nWelcome to the lab.\n';
const REPOSITORY_MOVED_ON = '# Handbook\n\nWelcome to the lab.\n\n## Advising\n\nWe meet weekly.\n';

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('manual apply', () => {
  let tempDir: string;
  let store: WorkspaceStore;
  let postMessage: jest.Mock;
  let update: jest.Mock;
  let slack: { chat: { postMessage: jest.Mock; update: jest.Mock } };

  const writeMirror = (content: string) => {
    const dir = path.join(tempDir, 'workspaces', 'T1', 'repo', 'docs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), content);
  };

  const pending = async () =>
    mutateDocState('T1', 'docs/a.md', (current) => ({
      ...(current ?? { status: 'synced', updatedAt: '' }),
      status: current?.status ?? 'synced',
      pendingManual: { targetHash: 'hash-of-the-repository-text', requestedAt: '2026-09-02T00:00:00.000Z' },
      updatedAt: '',
    }));

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-manual-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));
    await store.setGoogleDocMapping('T1', 'docs/a.md', {
      fileId: 'file-a',
      webViewLink: 'https://docs.google.com/document/d/file-a/edit',
      linkedBy: 'U-manager',
      mode: 'preserve',
    });

    postMessage = jest.fn().mockResolvedValue({ channel: 'D-manager', ts: '1.0' });
    update = jest.fn().mockResolvedValue({});
    slack = { chat: { postMessage, update } };

    mockClient.mockResolvedValue({} as never);
    mockExport.mockResolvedValue(DOC_EXPORT);
    mockGetMeta.mockResolvedValue({ fileId: 'file-a', version: '11' });
    mockDescribe.mockResolvedValue({ fileId: 'file-a', version: '10' });
    mockIsManager.mockResolvedValue(true);
    mockGetManagers.mockResolvedValue(['U-manager']);

    writeMirror(REPOSITORY_MOVED_ON);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    Reflect.deleteProperty(process.env, 'CHOIR_DB_KEY_FILE');
    Reflect.deleteProperty(process.env, 'CHOIR_DATA_DIR');
  });

  describe('choosing what to tell people about', () => {
    it('picks up a document with an outstanding request', async () => {
      await pending();
      expect(await documentsAwaitingNotice('T1')).toEqual(['docs/a.md']);
    });

    it('leaves alone one that has already been carded', async () => {
      await pending();
      await mutateDocState('T1', 'docs/a.md', (current) =>
        current
          ? { ...current, manualCards: [{ managerId: 'U-manager', channel: 'D', ts: '1.0' }], updatedAt: '' }
          : null,
      );

      expect(await documentsAwaitingNotice('T1')).toEqual([]);
    });

    it('leaves alone one somebody has decided to leave as it is', async () => {
      await pending();
      await declineManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md' });

      expect(await documentsAwaitingNotice('T1')).toEqual([]);
    });
  });

  describe('the diff the card carries', () => {
    it('shows what the repository has that the document does not', () => {
      const preview = buildDiffPreview(DOC_AS_REPOSITORY, REPOSITORY_MOVED_ON, t);

      expect(preview).toContain('+ ## Advising');
      expect(preview).toContain('+ We meet weekly.');
      expect(preview).toContain('@@ line');
    });

    it('says nothing when the two agree', () => {
      expect(buildDiffPreview(DOC_AS_REPOSITORY, DOC_AS_REPOSITORY, t)).toBe('');
    });

    it('stays inside what a Slack block can hold', () => {
      const huge = Array.from({ length: 4000 }, (_unused, index) => `line ${index}`).join('\n');
      const preview = buildDiffPreview('', huge, t);

      expect(preview.length).toBeLessThan(2400);
      expect(preview).toContain('more characters not shown');
    });
  });

  describe('sending the card', () => {
    it('DMs the managers and remembers where it put the cards', async () => {
      await pending();

      await notifyManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md', client: slack as never });

      expect(postMessage).toHaveBeenCalledTimes(1);
      const posted = postMessage.mock.calls[0][0];
      expect(posted.channel).toBe('U-manager');
      expect(JSON.stringify(posted.blocks)).toContain('gdocs_manual_applied');
      expect(JSON.stringify(posted.blocks)).toContain('## Advising');

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.manualCards).toEqual([{ managerId: 'U-manager', channel: 'D-manager', ts: '1.0' }]);
      // Kept apart from reviewCards, or a drift refresh would overwrite this card.
      expect(state?.reviewCards).toBeUndefined();
    });

    it('records no cards when every DM failed, so the next sweep tries again', async () => {
      await pending();
      postMessage.mockRejectedValue(new Error('cannot_dm_bot'));

      await notifyManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md', client: slack as never });

      expect((await getDocState('T1', 'docs/a.md'))?.manualCards).toBeUndefined();
      expect(await documentsAwaitingNotice('T1')).toEqual(['docs/a.md']);
    });

    it('says nothing about a document with no outstanding request', async () => {
      await notifyManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md', client: slack as never });

      expect(postMessage).not.toHaveBeenCalled();
    });
  });

  describe('accepting the claim that it was applied', () => {
    it('refuses while the document still differs from the repository', async () => {
      await pending();
      // The Doc has not been touched, so it does not hold the new section.
      const outcome = await confirmManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md' });

      expect(outcome).toBe('still-differs');
      // The request stands: clearing it would remove the only reminder anyone has.
      expect((await getDocState('T1', 'docs/a.md'))?.pendingManual).toBeDefined();
    });

    it('rebaselines against the document once it really does hold the change', async () => {
      await pending();
      mockExport.mockResolvedValue('# Handbook\n\nWelcome to the lab\\.\n\n## Advising\n\nWe meet weekly\\.\n');

      const outcome = await confirmManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md' });

      expect(outcome).toBe('applied');
      expect(mockReplace).not.toHaveBeenCalled();

      const state = await getDocState('T1', 'docs/a.md');
      expect(state?.pendingManual).toBeUndefined();
      expect(state?.status).toBe('synced');
    });

    it('does not accept a claim about a document with nothing outstanding', async () => {
      expect(await confirmManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md' })).toBe('nothing-pending');
    });
  });

  describe('leaving the document as it is', () => {
    it('records the decision once and refuses to record it twice', async () => {
      await pending();

      expect(await declineManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md' })).toBe(true);
      expect((await getDocState('T1', 'docs/a.md'))?.pendingManual?.declined).toBe(true);
      expect(await declineManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md' })).toBe(false);
    });
  });

  describe('retiring the cards', () => {
    it('rewrites them so the buttons go, and forgets them even if Slack was down', async () => {
      await pending();
      await notifyManualApply({ workspaceId: 'T1', githubPath: 'docs/a.md', client: slack as never });
      update.mockRejectedValue(new Error('channel_not_found'));

      await retireManualCards({
        workspaceId: 'T1',
        githubPath: 'docs/a.md',
        notice: { reason: 'gdocs.card.retired.unlinkedManual' },
        client: slack as never,
      });

      expect(update).toHaveBeenCalledTimes(1);
      expect((await getDocState('T1', 'docs/a.md'))?.manualCards).toBeUndefined();
    });
  });
});
