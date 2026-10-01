// The file list is in memory only. After a restart in OAuth mode it stayed empty
// until a webhook arrived, so "Apply" failed with "File not found in vector
// store". ensureLoaded fills it from the on-disk mirror on first use.

jest.mock('../services/retrieval', () => ({
  getRetrievalProvider: () => ({ search: async () => [] }),
}));

const mockGetConfig = jest.fn();
jest.mock('../services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({ getWorkspaceConfig: mockGetConfig })),
}));

const mockLoadMarkdownFiles = jest.fn();
jest.mock('../services/workspace/mirror-markdown-loader', () => ({
  WorkspaceMirrorMarkdownLoader: { getInstance: () => ({ loadMarkdownFiles: mockLoadMarkdownFiles }) },
}));

import { VectorStoreService } from '../services/file-registry/main-service';

function mkFile(path: string, content = ''): any {
  return { name: path.split('/').pop(), path, content, githubUrl: '', tree: {} };
}

const repo = { owner: 'o', repo: 'r', branch: 'main' };

describe('VectorStoreService.ensureLoaded', () => {
  const svc = VectorStoreService.getInstance();
  let ws: string;
  let n = 0;

  beforeEach(() => {
    ws = `T-ensure-${n++}`;
    mockGetConfig.mockReset();
    mockLoadMarkdownFiles.mockReset();
  });

  it('loads an unloaded workspace from the mirror', async () => {
    mockGetConfig.mockResolvedValue({ workspaceId: ws, githubRepo: repo });
    mockLoadMarkdownFiles.mockResolvedValue([mkFile('faq.md', 'faq')]);

    expect(svc.getMarkdownFile('faq.md', ws)).toBeUndefined();
    await expect(svc.ensureLoaded(ws)).resolves.toBe(true);
    expect(svc.getMarkdownFile('faq.md', ws)?.content).toBe('faq');
    expect(mockLoadMarkdownFiles).toHaveBeenCalledWith({ workspaceId: ws, ...repo });
  });

  it('reads the mirror once, however many callers arrive together', async () => {
    mockGetConfig.mockResolvedValue({ workspaceId: ws, githubRepo: repo });
    mockLoadMarkdownFiles.mockResolvedValue([mkFile('faq.md')]);

    await Promise.all([svc.ensureLoaded(ws), svc.ensureLoaded(ws), svc.ensureLoaded(ws)]);
    await svc.ensureLoaded(ws);
    expect(mockLoadMarkdownFiles).toHaveBeenCalledTimes(1);
  });

  it('leaves an already loaded workspace alone', async () => {
    await svc.initialize([mkFile('a.md', 'from webhook')], false, true, ws);

    await expect(svc.ensureLoaded(ws)).resolves.toBe(true);
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(svc.getMarkdownFile('a.md', ws)?.content).toBe('from webhook');
  });

  it('retries later when the workspace has no repo or an empty mirror', async () => {
    mockGetConfig.mockResolvedValueOnce({ workspaceId: ws });
    await expect(svc.ensureLoaded(ws)).resolves.toBe(false);

    mockGetConfig.mockResolvedValue({ workspaceId: ws, githubRepo: repo });
    mockLoadMarkdownFiles.mockResolvedValueOnce([]);
    await expect(svc.ensureLoaded(ws)).resolves.toBe(false);

    mockLoadMarkdownFiles.mockResolvedValueOnce([mkFile('b.md')]);
    await expect(svc.ensureLoaded(ws)).resolves.toBe(true);
  });

  it('counts a cleared workspace as unloaded again', async () => {
    await svc.initialize([mkFile('a.md')], false, true, ws);
    svc.clearWorkspaceState(ws);

    mockGetConfig.mockResolvedValue({ workspaceId: ws, githubRepo: repo });
    mockLoadMarkdownFiles.mockResolvedValue([mkFile('a.md', 'reloaded')]);
    await svc.ensureLoaded(ws);
    expect(svc.getMarkdownFile('a.md', ws)?.content).toBe('reloaded');
  });
});
