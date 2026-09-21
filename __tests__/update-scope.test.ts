// Which folder a conversation's document updates belong in.
//
// The helper is the whole of PF4's policy: everything downstream — the two
// candidate searches, the "create new file" default — reads a single
// `folderPrefix` from it. So the cases worth pinning are the ones where the
// answer must be `null`: no channel, no project, and a project that has
// deliberately chosen workspace-wide updates.

const resolveProjectForChannel = jest.fn();

jest.mock('services/projects/project-index', () => ({
  resolveProjectForChannel: (...args: unknown[]) => resolveProjectForChannel(...(args as [])),
}));

jest.mock('services/common/logger', () => ({
  Logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import {
  isUnderFolder,
  prefixNewFilePath,
  resolveUpdateScope,
  searchWithFolderFallback,
} from 'services/document/update-scope';

const project = (folder: string, updates: 'folder' | 'workspace') => ({
  folder,
  settings: {
    version: 1 as const,
    name: 'Alpha',
    description: 'The experiment platform rebuild.',
    channels: ['C1'],
    members: { source: 'channels' as const, curated: [], aliases: {} },
    scope: { retrieval: 'boost' as const, updates },
    meetingsFolder: 'meetings',
    glossary: 'GLOSSARY.md',
  },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveUpdateScope', () => {
  it('confines updates to the folder of a project channel', async () => {
    resolveProjectForChannel.mockResolvedValue(project('projects/alpha', 'folder'));

    const scope = await resolveUpdateScope('T1', 'C1');

    expect(scope.folderPrefix).toBe('projects/alpha');
    expect(scope.project?.folder).toBe('projects/alpha');
    expect(resolveProjectForChannel).toHaveBeenCalledWith('T1', 'C1');
  });

  it('keeps the project but drops the prefix when its updates are workspace-wide', async () => {
    resolveProjectForChannel.mockResolvedValue(project('projects/alpha', 'workspace'));

    const scope = await resolveUpdateScope('T1', 'C1');

    expect(scope.folderPrefix).toBeNull();
    expect(scope.project?.settings.description).toBe('The experiment platform rebuild.');
  });

  it('is workspace-wide for an unlinked channel', async () => {
    resolveProjectForChannel.mockResolvedValue(null);

    expect(await resolveUpdateScope('T1', 'C_RANDOM')).toEqual({ folderPrefix: null, project: null });
  });

  it('never asks the index without a channel', async () => {
    expect(await resolveUpdateScope('T1', undefined)).toEqual({ folderPrefix: null, project: null });
    expect(resolveProjectForChannel).not.toHaveBeenCalled();
  });

  it('falls back to the whole workspace when the index throws', async () => {
    resolveProjectForChannel.mockRejectedValue(new Error('no mirror'));

    expect(await resolveUpdateScope('T1', 'C1')).toEqual({ folderPrefix: null, project: null });
  });
});

describe('isUnderFolder', () => {
  it('matches documents inside the folder, at any depth', () => {
    expect(isUnderFolder('projects/alpha/design.md', 'projects/alpha')).toBe(true);
    expect(isUnderFolder('projects/alpha/meetings/2026-09-20.md', 'projects/alpha')).toBe(true);
  });

  it('does not match a sibling whose name merely starts the same', () => {
    expect(isUnderFolder('projects/alphabet/design.md', 'projects/alpha')).toBe(false);
    expect(isUnderFolder('projects/alpha.md', 'projects/alpha')).toBe(false);
  });

  it('does not match the folder itself or a document outside it', () => {
    expect(isUnderFolder('projects/alpha', 'projects/alpha')).toBe(false);
    expect(isUnderFolder('README.md', 'projects/alpha')).toBe(false);
    expect(isUnderFolder(undefined, 'projects/alpha')).toBe(false);
  });

  it('tolerates leading slashes and trailing slashes on either side', () => {
    expect(isUnderFolder('/projects/alpha/design.md', 'projects/alpha/')).toBe(true);
    expect(isUnderFolder('./projects/alpha/design.md', '/projects/alpha')).toBe(true);
  });
});

describe('searchWithFolderFallback', () => {
  it('searches once, unscoped, when there is no project folder', async () => {
    const search = jest.fn(async () => ['a']);

    expect(await searchWithFolderFallback({ folderPrefix: null, search })).toEqual({
      results: ['a'],
      widened: false,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(null);
  });

  it('keeps folder hits and does not widen', async () => {
    const search = jest.fn(async () => ['in-folder']);

    expect(await searchWithFolderFallback({ folderPrefix: 'projects/alpha', search })).toEqual({
      results: ['in-folder'],
      widened: false,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('projects/alpha');
  });

  it('redoes the search workspace-wide when the folder holds nothing, and says so', async () => {
    const search = jest.fn(async (prefix: string | null) => (prefix ? [] : ['elsewhere']));

    expect(await searchWithFolderFallback({ folderPrefix: 'projects/alpha', search })).toEqual({
      results: ['elsewhere'],
      widened: true,
    });
    expect(search.mock.calls).toEqual([['projects/alpha'], [null]]);
  });
});

describe('prefixNewFilePath', () => {
  it('puts a new document inside the project folder', () => {
    expect(prefixNewFilePath('projects/alpha', 'retention-policy.md')).toBe('projects/alpha/retention-policy.md');
  });

  it('leaves the name alone without a project folder', () => {
    expect(prefixNewFilePath(null, 'retention-policy.md')).toBe('retention-policy.md');
  });

  it('does not prefix a name that already names a place inside the folder', () => {
    expect(prefixNewFilePath('projects/alpha', 'projects/alpha/meetings/notes.md')).toBe(
      'projects/alpha/meetings/notes.md',
    );
  });

  it('strips the leading noise a generated name can carry', () => {
    expect(prefixNewFilePath('projects/alpha', './notes.md')).toBe('projects/alpha/notes.md');
    expect(prefixNewFilePath('projects/alpha/', '/notes.md')).toBe('projects/alpha/notes.md');
  });
});
