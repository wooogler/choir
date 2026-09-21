import { Document } from '@langchain/core/documents';
import type { ProjectRecord } from 'services/projects/project-index';
import { applyRetrievalScope, overFetchLimit, scopeForProject } from 'services/retrieval/scope';
import type { RetrievalDocument } from 'services/retrieval/types';

/**
 * The whole of the boost/exclusive behaviour, with no index behind it: this is
 * a pure function over the paths that came back, and that is the point of it
 * living in its own module.
 */

function doc(fileName: string): RetrievalDocument {
  return new Document({
    pageContent: fileName,
    metadata: {
      fileName,
      nodeId: `qmd:${fileName}`,
      sectionName: fileName,
      headingPath: fileName,
      nodeType: 'document',
      githubUrl: `https://github.com/acme/docs/blob/main/${fileName}`,
      originalContent: fileName,
    },
  }) as RetrievalDocument;
}

function paths(results: RetrievalDocument[]): string[] {
  return results.map((result) => result.metadata.fileName);
}

function project(overrides: Partial<ProjectRecord['settings']> = {}): ProjectRecord {
  return {
    folder: 'projects/alpha',
    settings: {
      version: 1,
      name: 'Alpha',
      description: 'The experiment platform.',
      channels: ['C0AB12CD3'],
      members: { source: 'channels', curated: [], aliases: {} },
      scope: { retrieval: 'boost', updates: 'folder' },
      meetingsFolder: 'meetings',
      glossary: 'GLOSSARY.md',
      ...overrides,
    },
  };
}

describe('scopeForProject', () => {
  it('turns a project folder into a prefix and keeps root files', () => {
    expect(scopeForProject(project())).toEqual({
      pathPrefixes: ['projects/alpha/'],
      mode: 'boost',
      includeRootFiles: true,
    });
  });

  it('carries the exclusive mode through', () => {
    expect(scopeForProject(project({ scope: { retrieval: 'exclusive', updates: 'folder' } }))?.mode).toBe('exclusive');
  });

  it('is null when the project asked for no scope at all', () => {
    expect(scopeForProject(project({ scope: { retrieval: 'off', updates: 'folder' } }))).toBeNull();
  });
});

describe('overFetchLimit', () => {
  it('asks the index for four times what the caller wants', () => {
    expect(overFetchLimit(5)).toBe(20);
  });

  it('caps the over-fetch so a large limit does not multiply without bound', () => {
    expect(overFetchLimit(40)).toBe(50);
  });
});

describe('applyRetrievalScope, boost', () => {
  const scope = { pathPrefixes: ['projects/alpha/'], mode: 'boost' as const, includeRootFiles: true };

  it('moves in-scope results to the front without reordering either half', () => {
    const results = [
      doc('projects/beta/design.md'),
      doc('projects/alpha/design.md'),
      doc('README.md'),
      doc('projects/alpha/meetings/weekly.md'),
    ];

    const scoped = applyRetrievalScope(results, scope, 4);

    expect(paths(scoped.results)).toEqual([
      'projects/alpha/design.md',
      'projects/alpha/meetings/weekly.md',
      'projects/beta/design.md',
      'README.md',
    ]);
    expect(scoped.widened).toBe(false);
  });

  it('cuts to the limit after the partition, so an out-of-scope hit can be dropped', () => {
    const results = [doc('projects/beta/design.md'), doc('projects/alpha/design.md')];

    expect(paths(applyRetrievalScope(results, scope, 1).results)).toEqual(['projects/alpha/design.md']);
  });

  it('never widens — boost always has the whole workspace to fall back on', () => {
    const results = [doc('projects/beta/design.md')];
    expect(applyRetrievalScope(results, scope, 5)).toEqual({ results, widened: false });
  });
});

describe('applyRetrievalScope, exclusive', () => {
  const scope = { pathPrefixes: ['projects/alpha/'], mode: 'exclusive' as const, includeRootFiles: true };

  it('drops everything outside the folder', () => {
    const results = [doc('projects/beta/design.md'), doc('projects/alpha/design.md'), doc('handbook/hr.md')];

    const scoped = applyRetrievalScope(results, scope, 5);

    expect(paths(scoped.results)).toEqual(['projects/alpha/design.md']);
    expect(scoped.widened).toBe(false);
  });

  it('keeps repository-root documents when asked to', () => {
    const results = [doc('handbook/hr.md'), doc('README.md'), doc('projects/alpha/design.md')];

    expect(paths(applyRetrievalScope(results, scope, 5).results)).toEqual(['README.md', 'projects/alpha/design.md']);
  });

  it('drops root documents when includeRootFiles is off', () => {
    const results = [doc('README.md'), doc('projects/alpha/design.md')];
    const strict = { ...scope, includeRootFiles: false };

    expect(paths(applyRetrievalScope(results, strict, 5).results)).toEqual(['projects/alpha/design.md']);
  });

  it('widens to the workspace results when nothing in the folder matched', () => {
    const results = [doc('projects/beta/design.md'), doc('handbook/hr.md'), doc('archive/old.md')];

    const scoped = applyRetrievalScope(results, { ...scope, includeRootFiles: false }, 2);

    expect(paths(scoped.results)).toEqual(['projects/beta/design.md', 'handbook/hr.md']);
    expect(scoped.widened).toBe(true);
  });

  it('widens on an empty result set rather than claiming a scope worked', () => {
    expect(applyRetrievalScope([], scope, 5)).toEqual({ results: [], widened: true });
  });
});

describe('applyRetrievalScope, path handling', () => {
  it('accepts a prefix written without its trailing slash', () => {
    const scoped = applyRetrievalScope(
      [doc('projects/alpha/design.md')],
      { pathPrefixes: ['projects/alpha'], mode: 'exclusive' },
      5,
    );

    expect(paths(scoped.results)).toEqual(['projects/alpha/design.md']);
  });

  it('does not let a sibling folder pass as a prefix match', () => {
    const scoped = applyRetrievalScope(
      [doc('projects/alpha-legacy/design.md')],
      { pathPrefixes: ['projects/alpha/'], mode: 'exclusive' },
      5,
    );

    expect(scoped.widened).toBe(true);
  });

  it('treats a result with no file name as out of scope', () => {
    const anonymous = new Document({ pageContent: 'body', metadata: {} }) as unknown as RetrievalDocument;

    const scoped = applyRetrievalScope(
      [anonymous, doc('projects/alpha/design.md')],
      { pathPrefixes: ['projects/alpha/'], mode: 'boost' },
      5,
    );

    expect(paths(scoped.results)[0]).toBe('projects/alpha/design.md');
  });

  it('matches more than one prefix', () => {
    const scoped = applyRetrievalScope(
      [doc('projects/beta/design.md'), doc('shared/notes.md')],
      { pathPrefixes: ['projects/beta/', 'shared/'], mode: 'exclusive' },
      5,
    );

    expect(paths(scoped.results)).toEqual(['projects/beta/design.md', 'shared/notes.md']);
  });
});
