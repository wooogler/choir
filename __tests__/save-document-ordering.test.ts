/**
 * The docs editor used to stage the edit into the workspace mirror before
 * pushing it to GitHub. A rejected push (no write access, protected branch,
 * GitHub down) then left the viewer and Q&A serving content that was never
 * committed, with nothing to reconcile it. These tests pin the ordering.
 */

const calls: string[] = [];

const commitFilesWithContext = jest.fn(async () => ({ commitSha: 'deadbeefcafe' }));
const stageMarkdownUpdate = jest.fn(async () => {
  calls.push('stage');
});
const markGithubSyncSuccess = jest.fn(async () => {
  calls.push('markSynced');
});

jest.mock('services/slack', () => ({
  getGithubRepo: jest.fn(async () => ({ owner: 'echo-lab', repo: 'assets', branch: 'master' })),
}));

jest.mock('services/document/document-update-service', () => ({
  DocumentUpdateService: {
    getInstance: () => ({ stageMarkdownUpdate, markGithubSyncSuccess }),
  },
}));

jest.mock('services/github', () => ({
  GithubService: {
    getInstance: () => ({
      commitFilesWithContext: (...args: unknown[]) => {
        calls.push('commit');
        return commitFilesWithContext(...(args as []));
      },
    }),
  },
}));

jest.mock('services/file-registry/main-service', () => ({
  VectorStoreService: {
    getInstance: () => ({
      getMarkdownFile: () => ({
        content: '# before',
        githubUrl: 'https://github.com/echo-lab/assets/blob/master/a.md',
      }),
      getAllMarkdownFiles: () => [],
      setLoadedMarkdownFiles: jest.fn(),
    }),
  },
}));

jest.mock('services/document/provenance', () => ({
  buildContextFile: jest.fn(async () => ({ path: '.choir/context/a.json.enc', content: 'v1:enc' })),
  persistContextToMirror: jest.fn(async () => {
    calls.push('persistContext');
  }),
}));

jest.mock('services/document', () => ({ parseMarkdownToTree: () => ({ sections: [] }) }));
jest.mock('services/document/image-captions', () => ({ enrichWorkspaceImageCaptions: jest.fn(async () => undefined) }));
jest.mock('services/retrieval/warmup', () => ({ scheduleQmdWarmup: jest.fn() }));

import { saveEditedDocument } from '../services/docs-editor/save-document';

const save = () =>
  saveEditedDocument({
    workspaceId: 'TCQV503UG',
    userId: 'U06MQGMDBLJ',
    filePath: '06_Conferences.md',
    content: '# after',
    commitMessage: 'Add CSCW',
  });

describe('saveEditedDocument ordering', () => {
  beforeEach(() => {
    calls.length = 0;
    jest.clearAllMocks();
    commitFilesWithContext.mockResolvedValue({ commitSha: 'deadbeefcafe' });
  });

  it('commits to GitHub before staging the edit into the mirror', async () => {
    await expect(save()).resolves.toEqual({ commitSha: 'deadbeefcafe' });

    expect(calls.indexOf('commit')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('commit')).toBeLessThan(calls.indexOf('stage'));
    expect(calls.indexOf('stage')).toBeLessThan(calls.indexOf('markSynced'));
  });

  it('leaves the mirror untouched when the GitHub write is rejected', async () => {
    commitFilesWithContext.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404, request: { method: 'POST' } }),
    );

    await expect(save()).rejects.toThrow('Not Found');

    expect(stageMarkdownUpdate).not.toHaveBeenCalled();
    expect(markGithubSyncSuccess).not.toHaveBeenCalled();
    expect(calls).toEqual(['commit']);
  });
});
