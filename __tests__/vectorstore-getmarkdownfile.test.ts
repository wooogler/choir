// getMarkdownFile does not use the retrieval provider, but VectorStoreService
// statically imports it (which pulls the heavy qmd/langchain chain). Stub it so
// this stays a fast, isolated unit test.
jest.mock('../services/retrieval', () => ({
  getRetrievalProvider: () => ({ search: async () => [] }),
}));

import { VectorStoreService } from '../services/file-registry/main-service';

function mkFile(path: string, content = ''): any {
  return { name: path.split('/').pop(), path, content, githubUrl: '', tree: {} };
}

describe('VectorStoreService.getMarkdownFile (path-first identity)', () => {
  const svc = VectorStoreService.getInstance();
  const ws = 'T-getmarkdownfile';

  beforeEach(async () => {
    await svc.initialize(
      [
        mkFile('README.md', 'root readme'),
        mkFile('docs/guide.md', 'guide'),
        mkFile('docs/a/README.md', 'a readme'),
        mkFile('docs/b/README.md', 'b readme'),
      ],
      true,
      false,
      ws,
    );
  });

  it('resolves a nested file by its full repo path (regression: Apply on nested docs)', () => {
    expect(svc.getMarkdownFile('docs/guide.md', ws)?.content).toBe('guide');
  });

  it('disambiguates duplicate basenames by full path', () => {
    expect(svc.getMarkdownFile('docs/a/README.md', ws)?.content).toBe('a readme');
    expect(svc.getMarkdownFile('docs/b/README.md', ws)?.content).toBe('b readme');
  });

  it('resolves a top-level file (path equals basename)', () => {
    expect(svc.getMarkdownFile('README.md', ws)?.content).toBe('root readme');
  });

  it('falls back to basename for a legacy caller passing just a unique file name', () => {
    expect(svc.getMarkdownFile('guide.md', ws)?.content).toBe('guide');
  });

  it('returns undefined for an unknown identity', () => {
    expect(svc.getMarkdownFile('nope.md', ws)).toBeUndefined();
  });

  it('prefers the exact path match over a basename collision', () => {
    // A bare "README.md" must resolve to the top-level file (path === "README.md"),
    // never to one of the nested siblings.
    expect(svc.getMarkdownFile('README.md', ws)?.content).toBe('root readme');
  });
});
