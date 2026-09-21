// Candidate documents for an update, restricted to one project folder.
//
// The retrieval provider has no path filter, so the folder scope is a
// post-filter — which makes two things worth pinning: that nothing outside the
// folder survives it, and that the over-fetch widens so a `k` of 5 still comes
// back with 5 when the folder's documents are buried under the rest of the
// repository. The fallback to a workspace-wide search is the caller's move
// (`searchWithFolderFallback`), so it is exercised here through the same pair
// of calls the review flow makes.

const search = jest.fn();
const getReadOnlyFiles = jest.fn(async () => [] as string[]);

jest.mock('services/retrieval', () => ({
  getRetrievalProvider: () => ({ search: (...args: unknown[]) => search(...(args as [])) }),
}));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({
    getReadOnlyFiles: (...args: unknown[]) => getReadOnlyFiles(...(args as [])),
  })),
}));

// The scope helper is real (its `isUnderFolder` is what does the filtering);
// only the index behind it is stubbed, so no mirror has to exist.
jest.mock('services/projects/project-index', () => ({
  resolveProjectForChannel: jest.fn(async () => null),
}));

jest.mock('services/common/logger', () => ({
  Logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { searchWithFolderFallback } from 'services/document/update-scope';
import { VectorStoreService } from 'services/file-registry/main-service';

const doc = (fileName: string) => ({ pageContent: fileName, metadata: { fileName } });

const store = VectorStoreService.getInstance();

beforeEach(() => {
  jest.clearAllMocks();
  getReadOnlyFiles.mockResolvedValue([]);
});

describe('similaritySearchWritableFiles with a folder prefix', () => {
  it('drops every candidate outside the folder', async () => {
    search.mockResolvedValue([
      doc('README.md'),
      doc('projects/alpha/design.md'),
      doc('projects/beta/design.md'),
      doc('projects/alpha/meetings/2026-09-20.md'),
      doc('projects/alphabet/notes.md'),
    ]);

    const results = await store.similaritySearchWritableFiles('deploy', 'T1', 5, undefined, 'projects/alpha');

    expect(results.map((d) => d.metadata.fileName)).toEqual([
      'projects/alpha/design.md',
      'projects/alpha/meetings/2026-09-20.md',
    ]);
  });

  it('over-fetches so the limit still fills when most of the repo is elsewhere', async () => {
    search.mockResolvedValue([
      ...Array.from({ length: 30 }, (_, i) => doc(`other/${i}.md`)),
      ...Array.from({ length: 6 }, (_, i) => doc(`projects/alpha/${i}.md`)),
    ]);

    const results = await store.similaritySearchWritableFiles('deploy', 'T1', 5, undefined, 'projects/alpha');

    // 5 * 8, not 5 * 3: the folder's documents are past the unscoped window.
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 40 }));
    expect(results).toHaveLength(5);
  });

  it('keeps the old window and the whole repository without a prefix', async () => {
    search.mockResolvedValue([doc('README.md'), doc('projects/alpha/design.md')]);

    const results = await store.similaritySearchWritableFiles('deploy', 'T1', 5);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 15 }));
    expect(results.map((d) => d.metadata.fileName)).toEqual(['README.md', 'projects/alpha/design.md']);
  });

  it('still excludes read-only documents inside the folder', async () => {
    getReadOnlyFiles.mockResolvedValue(['projects/alpha/meetings/']);
    search.mockResolvedValue([doc('projects/alpha/design.md'), doc('projects/alpha/meetings/2026-09-20.md')]);

    const results = await store.similaritySearchWritableFiles('deploy', 'T1', 5, undefined, 'projects/alpha');

    expect(results.map((d) => d.metadata.fileName)).toEqual(['projects/alpha/design.md']);
  });

  it('falls back to the whole repository when the folder holds nothing', async () => {
    search.mockImplementation(async () => [doc('README.md'), doc('handbook/policies.md')]);

    const { results, widened } = await searchWithFolderFallback({
      folderPrefix: 'projects/alpha',
      search: (prefix) => store.similaritySearchWritableFiles('deploy', 'T1', 5, undefined, prefix ?? undefined),
    });

    expect(widened).toBe(true);
    expect(results.map((d) => d.metadata.fileName)).toEqual(['README.md', 'handbook/policies.md']);
  });
});
