/**
 * A rename is the one document operation that touches every store keyed by a
 * path at once, and the commit is tagged `[choir-auto]` so nothing will ever
 * reconcile what it misses. So what is pinned here is the whole list from
 * docs/meeting-notes-and-glossary.md — commit, mirror, path map, index, Google
 * Docs mapping and state, read-only list — plus the rule that every refusal
 * happens before any of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let repoRoot = '';

const commitFilesWithContext = jest.fn(async () => ({ commitSha: 'deadbeefcafe' }));
const getFile = jest.fn(async (): Promise<{ content: string; sha: string } | null> => null);
const savePathMap = jest.fn(async () => undefined);
const setLoadedMarkdownFiles = jest.fn();
const scheduleQmdWarmup = jest.fn();
const renameDocState = jest.fn(async () => undefined);
const hasOpenReview = jest.fn(async () => false);

let indexedFiles: Array<{ name: string; path: string; content: string; githubUrl: string; tree: unknown }> = [];
let googleMapping: { fileId: string; webViewLink: string; linkedBy: string; mode?: string } | null = null;
let googleMappingWrites: Array<{ path: string; mapping: Record<string, unknown> }> = [];
let googleMappingRemovals: string[] = [];
let readOnlyFiles: string[] = [];

/** The mirror is a real temp directory: the sidecar move and the link count read it. */
function absolute(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function writeToDisk(relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(absolute(relativePath)), { recursive: true });
  fs.writeFileSync(absolute(relativePath), content, 'utf-8');
}

const writeMarkdownFile = jest.fn(async (_workspaceId: string, relativePath: string, content: string) => {
  writeToDisk(relativePath, content);
});
const removeMarkdownFile = jest.fn(async (_workspaceId: string, relativePath: string) => {
  fs.rmSync(absolute(relativePath), { force: true });
});
const readMirrorFile = jest.fn(async (_workspaceId: string, relativePath: string): Promise<string | null> => {
  try {
    return fs.readFileSync(absolute(relativePath), 'utf-8');
  } catch {
    return null;
  }
});

jest.mock('services/slack', () => ({
  getGithubRepo: jest.fn(async () => ({ owner: 'echo-lab', repo: 'assets', branch: 'main' })),
}));

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({
      getRepoRoot: () => repoRoot,
      readMirrorFile,
      writeMarkdownFile,
      removeMarkdownFile,
    }),
  },
}));

jest.mock('services/github', () => ({
  GithubService: { getInstance: () => ({ commitFilesWithContext, getFile }) },
}));

jest.mock('services/workspace/path-map-service', () => ({
  PathMapService: { getInstance: () => ({ save: savePathMap }) },
}));

jest.mock('services/file-registry/main-service', () => ({
  VectorStoreService: {
    getInstance: () => ({
      getAllMarkdownFiles: () => indexedFiles,
      ensureLoaded: async () => true,
      setLoadedMarkdownFiles,
    }),
  },
}));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: class {
    async getGoogleDocMapping() {
      return googleMapping;
    }
    async setGoogleDocMapping(_workspaceId: string, githubPath: string, mapping: Record<string, unknown>) {
      googleMappingWrites.push({ path: githubPath, mapping });
    }
    async removeGoogleDocMapping(_workspaceId: string, githubPath: string) {
      googleMappingRemovals.push(githubPath);
      return true;
    }
    async getReadOnlyFiles() {
      return readOnlyFiles;
    }
    async setReadOnlyFiles(_workspaceId: string, next: string[]) {
      readOnlyFiles = next;
      return true;
    }
  },
}));

jest.mock('services/google/gdocs-state', () => ({ renameDocState }));
jest.mock('services/google/review-service', () => ({ hasOpenReview }));
jest.mock('services/retrieval/warmup', () => ({ scheduleQmdWarmup }));
jest.mock('services/document', () => ({ parseMarkdownToTree: () => ({ sections: [] }) }));

import { RenameDocumentRefusal, checkRename, renameDocument } from '../services/docs-editor/rename-document';

const WORKSPACE = 'T-RENAME';
const ACTOR = { workspaceId: WORKSPACE, userId: 'U-manager' };

interface CommitCall {
  message: string;
  files: Array<{ path: string; content: string }>;
  deletions?: string[];
}

function lastCommit(): CommitCall {
  const call = commitFilesWithContext.mock.calls.at(-1);
  if (!call) throw new Error('nothing was committed');
  return call[0] as unknown as CommitCall;
}

beforeEach(() => {
  jest.clearAllMocks();
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-rename-'));
  indexedFiles = [];
  googleMapping = null;
  googleMappingWrites = [];
  googleMappingRemovals = [];
  readOnlyFiles = [];
  getFile.mockResolvedValue(null);
  hasOpenReview.mockResolvedValue(false);
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('renameDocument: the commit', () => {
  it('moves the document and its provenance sidecars in one commit', async () => {
    writeToDisk('policy/onboarding.md', '# Onboarding\n');
    writeToDisk('.choir/context/policy/onboarding.md/1700000000-aaaa.json.enc', 'v1:first');
    writeToDisk('.choir/context/policy/onboarding.md/1700000001-bbbb.json.enc', 'v1:second');

    const result = await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    const commit = lastCommit();
    expect(commit.message).toBe('Rename policy/onboarding.md → policy/welcome.md');
    expect(commit.files).toContainEqual({ path: 'policy/welcome.md', content: '# Onboarding\n' });
    expect(commit.files).toContainEqual({
      path: '.choir/context/policy/welcome.md/1700000000-aaaa.json.enc',
      content: 'v1:first',
    });
    expect(commit.files).toContainEqual({
      path: '.choir/context/policy/welcome.md/1700000001-bbbb.json.enc',
      content: 'v1:second',
    });
    expect(commit.deletions).toEqual(
      expect.arrayContaining([
        'policy/onboarding.md',
        '.choir/context/policy/onboarding.md/1700000000-aaaa.json.enc',
        '.choir/context/policy/onboarding.md/1700000001-bbbb.json.enc',
      ]),
    );
    expect(result).toMatchObject({ commitSha: 'deadbeefcafe', from: 'policy/onboarding.md', to: 'policy/welcome.md' });
  });

  it('commits a document that has no sidecars at all', async () => {
    writeToDisk('README.md', '# Readme\n');

    await renameDocument({ ...ACTOR, from: 'README.md', to: 'guide.md' });

    const commit = lastCommit();
    expect(commit.files).toEqual([{ path: 'guide.md', content: '# Readme\n' }]);
    expect(commit.deletions).toEqual(['README.md']);
  });

  it('writes no provenance record: a rename changes no content', async () => {
    writeToDisk('README.md', '# Readme\n');

    await renameDocument({ ...ACTOR, from: 'README.md', to: 'guide.md' });

    // Only the document itself — a `.choir/context/...` entry here would be a
    // freshly filed record claiming an edit nobody made.
    expect(lastCommit().files).toHaveLength(1);
  });
});

describe('renameDocument: the local state keyed to the path', () => {
  beforeEach(() => {
    writeToDisk('policy/onboarding.md', '# Onboarding\n');
    writeToDisk('.choir/context/policy/onboarding.md/1700000000-aaaa.json.enc', 'v1:first');
    writeToDisk('other.md', '# Other\n');
  });

  it('moves the file and the sidecar folder in the mirror', async () => {
    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(writeMarkdownFile).toHaveBeenCalledWith(WORKSPACE, 'policy/welcome.md', '# Onboarding\n');
    expect(removeMarkdownFile).toHaveBeenCalledWith(WORKSPACE, 'policy/onboarding.md');
    expect(fs.existsSync(absolute('.choir/context/policy/onboarding.md'))).toBe(false);
    expect(fs.readFileSync(absolute('.choir/context/policy/welcome.md/1700000000-aaaa.json.enc'), 'utf-8')).toBe(
      'v1:first',
    );
  });

  it('re-saves the path map from the surviving documents, since it is add-only', async () => {
    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(savePathMap).toHaveBeenCalledWith(WORKSPACE, ['other.md', 'policy/welcome.md']);
  });

  it('replaces the vector store entry, with a GitHub URL for the new path', async () => {
    indexedFiles = [
      {
        name: 'onboarding.md',
        path: 'policy/onboarding.md',
        content: '# Onboarding\n',
        githubUrl: 'https://github.com/echo-lab/assets/blob/main/policy/onboarding.md',
        tree: {},
      },
      { name: 'other.md', path: 'other.md', content: '# Other\n', githubUrl: 'https://example.test/other', tree: {} },
    ];

    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    const [next] = setLoadedMarkdownFiles.mock.calls.at(-1) as [Array<{ path: string; githubUrl: string }>];
    expect(next.map((file) => file.path).sort()).toEqual(['other.md', 'policy/welcome.md']);
    expect(next.find((file) => file.path === 'policy/welcome.md')?.githubUrl).toBe(
      'https://github.com/echo-lab/assets/blob/main/policy/welcome.md',
    );
    expect(scheduleQmdWarmup).toHaveBeenCalledWith({ workspaceId: WORKSPACE, reason: 'docs-editor-rename' });
  });

  it('re-keys the Google Doc mapping and its sync state when one exists', async () => {
    googleMapping = { fileId: 'doc-1', webViewLink: 'https://docs.test/doc-1', linkedBy: 'U-manager', mode: 'replica' };

    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(googleMappingRemovals).toEqual(['policy/onboarding.md']);
    expect(googleMappingWrites).toEqual([
      {
        path: 'policy/welcome.md',
        mapping: {
          fileId: 'doc-1',
          webViewLink: 'https://docs.test/doc-1',
          linkedBy: 'U-manager',
          mode: 'replica',
        },
      },
    ]);
    expect(renameDocState).toHaveBeenCalledWith(WORKSPACE, 'policy/onboarding.md', 'policy/welcome.md');
  });

  it('leaves the Google Docs state alone for a document that was never linked', async () => {
    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(googleMappingRemovals).toEqual([]);
    expect(googleMappingWrites).toEqual([]);
    expect(renameDocState).not.toHaveBeenCalled();
  });

  it('carries a read-only mark across, by path', async () => {
    readOnlyFiles = ['policy/onboarding.md', 'other.md'];

    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(readOnlyFiles.sort()).toEqual(['other.md', 'policy/welcome.md']);
  });

  it('carries a read-only mark stored in the legacy basename form, and writes back a path', async () => {
    readOnlyFiles = ['onboarding.md'];

    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(readOnlyFiles).toEqual(['policy/welcome.md']);
  });

  it('leaves a read-only list that does not mention the document untouched', async () => {
    readOnlyFiles = ['other.md'];

    await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(readOnlyFiles).toEqual(['other.md']);
  });
});

describe('renameDocument: refusals happen before anything is committed', () => {
  const expectRefusal = async (promise: Promise<unknown>, status: number, apiCode: string) => {
    await expect(promise).rejects.toMatchObject({ name: 'RenameDocumentRefusal', status, apiCode });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
    expect(writeMarkdownFile).not.toHaveBeenCalled();
    expect(removeMarkdownFile).not.toHaveBeenCalled();
  };

  it('refuses a path that is not a repository markdown path', async () => {
    writeToDisk('README.md', '# Readme\n');
    await expectRefusal(
      renameDocument({ ...ACTOR, from: 'README.md', to: '../outside.md' }),
      400,
      'invalid_document_path',
    );
  });

  it('refuses a rename onto the path the document already has', async () => {
    writeToDisk('README.md', '# Readme\n');
    await expectRefusal(
      // Normalization makes these the same path, which is the interesting case:
      // it would commit a delete and a create for one path.
      renameDocument({ ...ACTOR, from: 'README.md', to: '/README.MD' }),
      400,
      'invalid_document_path',
    );
  });

  it('refuses when the document is not in the mirror', async () => {
    await expectRefusal(
      renameDocument({ ...ACTOR, from: 'policy/missing.md', to: 'policy/welcome.md' }),
      404,
      'document_not_found',
    );
  });

  it('refuses when something already lives at the destination', async () => {
    writeToDisk('README.md', '# Readme\n');
    writeToDisk('guide.md', '# Guide\n');

    await expect(renameDocument({ ...ACTOR, from: 'README.md', to: 'guide.md' })).rejects.toMatchObject({
      status: 409,
      apiCode: 'document_exists',
      detail: { path: 'guide.md' },
    });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('refuses a destination that exists only on GitHub, which the mirror may not have synced', async () => {
    writeToDisk('README.md', '# Readme\n');
    getFile.mockResolvedValue({ content: '# Guide', sha: 'abc' });

    await expectRefusal(renameDocument({ ...ACTOR, from: 'README.md', to: 'guide.md' }), 409, 'document_exists');
  });

  it('refuses a document with an open Google Docs review', async () => {
    writeToDisk('README.md', '# Readme\n');
    hasOpenReview.mockResolvedValue(true);

    await expectRefusal(renameDocument({ ...ACTOR, from: 'README.md', to: 'guide.md' }), 409, 'rename_review_pending');
    expect(hasOpenReview).toHaveBeenCalledWith(WORKSPACE, 'README.md');
  });

  it('is a RenameDocumentRefusal, so the route can answer it with its own code', async () => {
    await expect(renameDocument({ ...ACTOR, from: 'x.txt', to: 'y.md' })).rejects.toBeInstanceOf(RenameDocumentRefusal);
  });
});

describe('renameDocument: the inbound link warning', () => {
  it('reports how many other documents link to the old path', async () => {
    writeToDisk('policy/onboarding.md', '# Onboarding\n');
    writeToDisk('README.md', 'See [it](policy/onboarding.md) and [again](policy/onboarding.md).\n');
    writeToDisk('guides/setup.md', 'See [it](../policy/onboarding.md).\n');
    writeToDisk('guides/other.md', 'Nothing.\n');

    const result = await renameDocument({ ...ACTOR, from: 'policy/onboarding.md', to: 'policy/welcome.md' });

    expect(result.inboundLinks).toBe(2);
    // The links themselves are deliberately left alone in this stage.
    expect(fs.readFileSync(absolute('README.md'), 'utf-8')).toContain('policy/onboarding.md');
  });
});

describe('checkRename', () => {
  it('answers the dialog’s three questions without committing anything', async () => {
    writeToDisk('policy/onboarding.md', '# Onboarding\n');
    writeToDisk('README.md', 'See [it](policy/onboarding.md).\n');

    const result = await checkRename({
      workspaceId: WORKSPACE,
      userId: 'U-manager',
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
    });

    expect(result).toEqual({
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
      exists: false,
      reviewPending: false,
      inboundLinks: 1,
      sameFolder: true,
    });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('reports an occupied destination and a pending review rather than throwing', async () => {
    writeToDisk('policy/onboarding.md', '# Onboarding\n');
    writeToDisk('policy/welcome.md', '# Welcome\n');
    hasOpenReview.mockResolvedValue(true);

    const result = await checkRename({
      workspaceId: WORKSPACE,
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
    });

    expect(result).toMatchObject({ exists: true, reviewPending: true });
  });

  it('says when the document is changing folders, which is a move', async () => {
    writeToDisk('policy/onboarding.md', '# Onboarding\n');

    const result = await checkRename({
      workspaceId: WORKSPACE,
      from: 'policy/onboarding.md',
      to: 'meetings/onboarding.md',
    });

    expect(result.sameFolder).toBe(false);
  });

  it('still refuses an unusable path', async () => {
    await expect(
      checkRename({ workspaceId: WORKSPACE, from: 'policy/onboarding.md', to: 'notes.txt' }),
    ).rejects.toMatchObject({ status: 400, apiCode: 'invalid_document_path' });
  });
});
