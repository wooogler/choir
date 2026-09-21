/**
 * The order of a workspace sync.
 *
 * The project index is rebuilt by walking the mirror, so invalidating it before
 * the project files land would just cache the pre-sync tree again. This pins
 * the sequence: markdown, then project files, then the invalidation.
 */

const order: string[] = [];
let projectSyncFails = false;

jest.mock('services/document/image-captions', () => ({
  enrichWorkspaceImageCaptions: async () => undefined,
}));

jest.mock('services/file-registry/main-service', () => ({
  VectorStoreService: { getInstance: () => ({ setLoadedMarkdownFiles: () => undefined }) },
}));

jest.mock('services/github', () => ({
  GithubService: { getInstance: () => ({ getAllMarkdownFiles: async () => [] }) },
}));

jest.mock('services/google/replica-publisher', () => ({
  schedulePublishAll: () => undefined,
}));

jest.mock('services/projects/project-index', () => ({
  invalidateProjectIndex: () => order.push('invalidate'),
}));

jest.mock('services/retrieval/warmup', () => ({
  scheduleQmdWarmup: () => undefined,
}));

jest.mock('services/workspace/mirror-markdown-loader', () => ({
  WorkspaceMirrorMarkdownLoader: { getInstance: () => ({ loadMarkdownFiles: async () => [] }) },
}));

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({
      syncMarkdownFiles: async () => {
        order.push('markdown');
      },
    }),
  },
}));

jest.mock('services/sync/project-file-sync', () => ({
  syncProjectFiles: async () => {
    order.push('project-files');
    if (projectSyncFails) throw new Error('GitHub is down');
    return { written: [], removed: [] };
  },
}));

import { GitHubSyncService } from 'services/sync/github-sync-service';

const params = {
  workspaceId: 'T1',
  owner: 'acme',
  repo: 'docs',
  branch: 'main',
  markdownFiles: [],
  source: 'startup' as const,
};

beforeEach(() => {
  order.length = 0;
  projectSyncFails = false;
});

describe('syncWorkspaceFromMarkdownFiles', () => {
  it('syncs the project files after the markdown and invalidates the index last', async () => {
    await GitHubSyncService.getInstance().syncWorkspaceFromMarkdownFiles(params);

    expect(order).toEqual(['markdown', 'project-files', 'invalidate']);
  });

  it('still finishes the sync when the project files could not be fetched', async () => {
    projectSyncFails = true;

    await expect(GitHubSyncService.getInstance().syncWorkspaceFromMarkdownFiles(params)).resolves.toBeUndefined();
    expect(order).toEqual(['markdown', 'project-files', 'invalidate']);
  });
});
