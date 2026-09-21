/**
 * The provider half of the search scope: with a scope in hand it must ask the
 * index for more than the caller wants, filter what comes back, and say so
 * when an `exclusive` scope had to be widened.
 *
 * Everything the provider reaches for is mocked — a repo, a mirror, an embed
 * guard and a QMD store are all beside the point here. The store itself comes
 * in through `loadQmdModule`, which is `protected` for exactly this reason.
 */

const searchCalls: Array<{ limit?: number }> = [];
let hybridResults: Array<{ file: string; displayPath: string; title: string; body: string; score: number }> = [];

jest.mock('services/slack', () => ({
  getGithubRepo: async () => ({ owner: 'acme', repo: 'docs', branch: 'main' }),
}));

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({
      getWorkspaceRoot: () => '/tmp/ws',
      getSectionsRoot: () => '/tmp/ws/sections',
      getRepoRoot: () => '/tmp/ws/repo',
      getSyncState: async () => null,
      populateSectionsIfEmpty: async () => undefined,
    }),
  },
}));

jest.mock('services/workspace/path-map-service', () => ({
  PathMapService: {
    getInstance: () => ({ getOriginalPath: (_workspaceId: string, relativePath: string) => relativePath }),
  },
}));

jest.mock('services/retrieval/qmd-embed-guard', () => ({
  VECTOR_SEARCH_FAILURE_HINT: 'hint',
  ensureEmbedModelUpToDate: async () => 'up-to-date',
  getConfiguredEmbedModel: () => 'test-embed',
  getVectorSearchFailureCount: () => 0,
  recordVectorSearchFailure: () => 1,
  writeIndexMeta: async () => undefined,
}));

jest.mock('services/retrieval/repository-language', () => ({
  detectRepositoryLanguage: async () => 'en',
}));

jest.mock('services/llm/query-translation', () => ({
  buildCrossLingualSearchQueries: async () => [{ type: 'lex', query: 'holiday' }],
}));

jest.mock('services/retrieval/qmd-lex-search', () => ({
  buildQmdStructuredSearchQueries: () => [{ type: 'lex', query: 'holiday' }],
  searchQmdLexWithFallback: async () => ({ results: [], matchedCandidate: undefined, queryCandidates: [] }),
}));

import { type QmdModule, QmdRetrievalProvider } from 'services/retrieval/qmd-provider';
import type { RetrievalScope } from 'services/retrieval/types';

/** A section path as QMD reports it: `<collection>/<repo path>/<section>.md`. */
function hit(repoPath: string, score: number) {
  return {
    file: `qmd://docs/${repoPath}/0.md`,
    displayPath: `docs/${repoPath}/0.md`,
    title: repoPath,
    body: `body of ${repoPath}`,
    score,
  };
}

class TestProvider extends QmdRetrievalProvider {
  protected async loadQmdModule(): Promise<QmdModule> {
    return {
      createStore: async () => ({
        searchLex: async () => [],
        search: async (options: { limit?: number }) => {
          searchCalls.push({ limit: options.limit });
          return hybridResults;
        },
        update: async () => ({ needsEmbedding: 0 }),
        embed: async () => ({}),
        close: async () => undefined,
      }),
    } as unknown as QmdModule;
  }
}

function provider(): TestProvider {
  return new TestProvider();
}

function paths(documents: Array<{ metadata: { fileName: string } }>): string[] {
  return documents.map((document) => document.metadata.fileName);
}

beforeEach(() => {
  searchCalls.length = 0;
  hybridResults = [];
});

describe('QmdRetrievalProvider.searchWithMeta', () => {
  it('asks the index for the plain limit when there is no scope', async () => {
    hybridResults = [hit('handbook/hr.md', 0.9)];

    const result = await provider().searchWithMeta({ query: 'holiday', limit: 5, workspaceId: 'T1' });

    expect(searchCalls[0].limit).toBe(5);
    expect(result.widened).toBe(false);
    expect(paths(result.documents)).toEqual(['handbook/hr.md']);
  });

  it('over-fetches four times the limit when a scope has to be applied afterwards', async () => {
    const scope: RetrievalScope = { pathPrefixes: ['projects/alpha/'], mode: 'boost', includeRootFiles: true };
    hybridResults = [hit('projects/alpha/design.md', 0.9)];

    await provider().searchWithMeta({ query: 'holiday', limit: 5, workspaceId: 'T1', scope });

    expect(searchCalls[0].limit).toBe(20);
  });

  it('boosts the project folder to the front and still returns only `limit` documents', async () => {
    const scope: RetrievalScope = { pathPrefixes: ['projects/alpha/'], mode: 'boost', includeRootFiles: true };
    hybridResults = [
      hit('projects/beta/design.md', 0.95),
      hit('handbook/hr.md', 0.9),
      hit('projects/alpha/design.md', 0.4),
    ];

    const result = await provider().searchWithMeta({ query: 'holiday', limit: 2, workspaceId: 'T1', scope });

    expect(paths(result.documents)).toEqual(['projects/alpha/design.md', 'projects/beta/design.md']);
    expect(result.widened).toBe(false);
  });

  it('keeps only the project folder and the repository root under an exclusive scope', async () => {
    const scope: RetrievalScope = { pathPrefixes: ['projects/alpha/'], mode: 'exclusive', includeRootFiles: true };
    hybridResults = [hit('projects/beta/design.md', 0.95), hit('README.md', 0.5), hit('projects/alpha/design.md', 0.4)];

    const result = await provider().searchWithMeta({ query: 'holiday', limit: 5, workspaceId: 'T1', scope });

    expect(paths(result.documents)).toEqual(['README.md', 'projects/alpha/design.md']);
    expect(result.widened).toBe(false);
  });

  it('reports widened when an exclusive scope matched nothing, and returns the workspace results', async () => {
    const scope: RetrievalScope = { pathPrefixes: ['projects/alpha/'], mode: 'exclusive' };
    hybridResults = [hit('projects/beta/design.md', 0.95), hit('handbook/hr.md', 0.9)];

    const result = await provider().searchWithMeta({ query: 'holiday', limit: 5, workspaceId: 'T1', scope });

    expect(result.widened).toBe(true);
    expect(paths(result.documents)).toEqual(['projects/beta/design.md', 'handbook/hr.md']);
  });

  it('keeps `search` returning a plain array, scope or not', async () => {
    const scope: RetrievalScope = { pathPrefixes: ['projects/alpha/'], mode: 'boost' };
    hybridResults = [hit('projects/alpha/design.md', 0.9)];

    const documents = await provider().search({ query: 'holiday', limit: 5, workspaceId: 'T1', scope });

    expect(Array.isArray(documents)).toBe(true);
    expect(paths(documents)).toEqual(['projects/alpha/design.md']);
  });
});
