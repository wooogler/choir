/**
 * Creating a document from the viewer writes a commit from a path someone typed
 * into a text box, so the two things worth pinning are where that path may land
 * and what happens when something is already there: a creation that overwrote a
 * document would be a silent, unreviewed replacement of somebody's work.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const commitFilesWithContext = jest.fn(async () => ({ commitSha: 'deadbeefcafe' }));
const getFile = jest.fn(async (): Promise<{ content: string; sha: string } | null> => null);
const buildContextFile = jest.fn(async () => ({ path: '.choir/context/a.json.enc', content: 'v1:enc' }));
const readMirrorFile = jest.fn(async (): Promise<string | null> => null);

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-create-'));

jest.mock('services/slack', () => ({
  getGithubRepo: jest.fn(async () => ({ owner: 'echo-lab', repo: 'assets', branch: 'main' })),
}));

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({ readMirrorFile, getRepoRoot: () => repoRoot }),
  },
}));

jest.mock('services/document/document-update-service', () => ({
  DocumentUpdateService: {
    getInstance: () => ({ stageMarkdownUpdate: jest.fn(async () => undefined), markGithubSyncSuccess: jest.fn() }),
  },
}));

jest.mock('services/github', () => ({
  GithubService: { getInstance: () => ({ commitFilesWithContext, getFile }) },
}));

jest.mock('services/file-registry/main-service', () => ({
  VectorStoreService: {
    getInstance: () => ({
      // Nothing is indexed under a path that does not exist yet.
      getMarkdownFile: () => undefined,
      getAllMarkdownFiles: () => [],
      setLoadedMarkdownFiles: jest.fn(),
    }),
  },
}));

jest.mock('services/document/provenance', () => ({
  buildContextFile,
  persistContextToMirror: jest.fn(async () => undefined),
}));

jest.mock('services/document', () => ({ parseMarkdownToTree: () => ({ sections: [] }) }));
jest.mock('services/document/image-captions', () => ({ enrichWorkspaceImageCaptions: jest.fn(async () => undefined) }));
jest.mock('services/retrieval/warmup', () => ({ scheduleQmdWarmup: jest.fn() }));
jest.mock('services/google/replica-publisher', () => ({ schedulePublish: jest.fn() }));

import { CreateDocumentRefusal, createDocument } from '../services/docs-editor/create-document';
import { documentTitleFromPath, normalizeDocumentPath } from '../services/docs-editor/document-path';
import { normalizeImportPath } from '../services/google/import-path';

describe('normalizeDocumentPath', () => {
  it('accepts ordinary repository paths', () => {
    expect(normalizeDocumentPath('README.md')).toBe('README.md');
    expect(normalizeDocumentPath('policy/onboarding.md')).toBe('policy/onboarding.md');
    expect(normalizeDocumentPath('  spaced.md  ')).toBe('spaced.md');
    expect(normalizeDocumentPath('/leading-slash.md')).toBe('leading-slash.md');
  });

  it('refuses anything that is not markdown', () => {
    expect(normalizeDocumentPath('notes.txt')).toBeNull();
    expect(normalizeDocumentPath('notes')).toBeNull();
    expect(normalizeDocumentPath('')).toBeNull();
    expect(normalizeDocumentPath('   ')).toBeNull();
  });

  it('refuses escaping the repository', () => {
    expect(normalizeDocumentPath('../outside.md')).toBeNull();
    expect(normalizeDocumentPath('policy/../../outside.md')).toBeNull();
    expect(normalizeDocumentPath('a/../../../etc/passwd.md')).toBeNull();
  });

  it('refuses the directories that hold provenance and binaries', () => {
    expect(normalizeDocumentPath('.choir')).toBeNull();
    expect(normalizeDocumentPath('.choir/context/thing.md')).toBeNull();
    expect(normalizeDocumentPath('assets/thing.md')).toBeNull();
  });

  it('folds the extension to lowercase, so the file listing can see it', () => {
    // app.ts's mirror walk and deleteDocument both match `.md` case-sensitively:
    // `Policy.MD` would be committed and then never appear in the sidebar.
    expect(normalizeDocumentPath('Policy.MD')).toBe('Policy.md');
    expect(normalizeDocumentPath('policy/Onboarding.Md')).toBe('policy/Onboarding.md');
    expect(normalizeDocumentPath('README.md')).toBe('README.md');
  });

  it('collapses redundant segments rather than trusting them', () => {
    expect(normalizeDocumentPath('policy/./onboarding.md')).toBe('policy/onboarding.md');
    expect(normalizeDocumentPath('policy/drafts/../onboarding.md')).toBe('policy/onboarding.md');
  });
});

describe('normalizeImportPath', () => {
  it('still answers exactly what the shared rule answers', () => {
    // The import kept its own name for the check after the rule moved; a
    // divergence here would let a Doc land where a document may not.
    const candidates = [
      'README.md',
      '  policy/onboarding.md  ',
      '/leading-slash.md',
      'notes.txt',
      '../outside.md',
      'assets/thing.md',
      '.choir/context/thing.md',
      'policy/drafts/../onboarding.md',
      'Policy.MD',
      '',
    ];
    for (const candidate of candidates) {
      expect([candidate, normalizeImportPath(candidate)]).toEqual([candidate, normalizeDocumentPath(candidate)]);
    }
  });
});

describe('documentTitleFromPath', () => {
  it('reads a filename the way the viewer’s sidebar reads it', () => {
    expect(documentTitleFromPath('06_Conferences.md')).toBe('Conferences');
    expect(documentTitleFromPath('policy/lab-onboarding.md')).toBe('lab onboarding');
    expect(documentTitleFromPath('README.md')).toBe('README');
    expect(documentTitleFromPath('연구실-규정.md')).toBe('연구실 규정');
  });

  it('falls back to the path when the name strips down to nothing', () => {
    expect(documentTitleFromPath('01_.md')).toBe('01_.md');
  });
});

describe('createDocument', () => {
  const create = (overrides: Partial<Parameters<typeof createDocument>[0]> = {}) =>
    createDocument({ workspaceId: 'T1', userId: 'U1', filePath: 'policy/new-doc.md', ...overrides });

  beforeEach(() => {
    jest.clearAllMocks();
    readMirrorFile.mockResolvedValue(null);
    getFile.mockResolvedValue(null);
    commitFilesWithContext.mockResolvedValue({ commitSha: 'deadbeefcafe' });
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('refuses a path that is already taken, before committing anything', async () => {
    readMirrorFile.mockResolvedValue('# already here');

    await expect(create()).rejects.toMatchObject({ status: 409, apiCode: 'document_exists' });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('refuses a directory wearing a document’s name, rather than failing on it', async () => {
    // `readMirrorFile` only forgives ENOENT, so reading a directory throws
    // EISDIR. If the on-disk check did not come first the refusal would surface
    // as a 500, which tells the manager nothing about the real problem.
    fs.mkdirSync(path.join(repoRoot, 'policy', 'occupied.md'), { recursive: true });
    readMirrorFile.mockRejectedValue(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }));

    await expect(create({ filePath: 'policy/occupied.md' })).rejects.toMatchObject({
      status: 409,
      apiCode: 'document_exists',
    });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('treats a mirror it cannot read as occupied', async () => {
    // Nothing on disk to short-circuit on, so this is the mirror read itself
    // failing. A path CHOIR cannot look at is not one it should commit over.
    readMirrorFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    await expect(create()).rejects.toMatchObject({ status: 409, apiCode: 'document_exists' });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('refuses a path GitHub holds but the mirror has never seen', async () => {
    // The mirror is a cache: a fresh install, a missed push webhook, or a commit
    // from five minutes ago all leave it saying "absent" about a document that
    // exists. Committing then would replace it and file the replacement as a new
    // file with an empty `before`.
    getFile.mockResolvedValue({ content: '# live on GitHub', sha: 'abc123' });

    await expect(create()).rejects.toMatchObject({ status: 409, apiCode: 'document_exists' });
    expect(readMirrorFile).toHaveBeenCalled();
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('asks GitHub about the branch the workspace writes to', async () => {
    await create();

    expect(getFile).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'echo-lab', repo: 'assets', branch: 'main', path: 'policy/new-doc.md' }),
    );
  });

  it('refuses an unusable path without reaching the mirror', async () => {
    await expect(create({ filePath: 'assets/thing.md' })).rejects.toBeInstanceOf(CreateDocumentRefusal);
    await expect(create({ filePath: '../outside.md' })).rejects.toMatchObject({
      status: 400,
      apiCode: 'invalid_document_path',
    });
    expect(readMirrorFile).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('starts the document as its own title, and names the commit after the path', async () => {
    await expect(create({ filePath: '  /policy/01_new-doc.md  ' })).resolves.toEqual({
      commitSha: 'deadbeefcafe',
      filePath: 'policy/01_new-doc.md',
    });

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as {
      message: string;
      files: Array<{ path: string; content: string }>;
    };
    expect(commit.message).toBe('Create policy/01_new-doc.md');
    expect(commit.files[0]).toEqual({ path: 'policy/01_new-doc.md', content: '# new doc\n' });
  });

  it('keeps the content and commit message the caller sent', async () => {
    await create({ content: '# Written by hand\n\nBody.\n', commitMessage: 'Start the onboarding policy' });

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as {
      message: string;
      files: Array<{ content: string }>;
    };
    expect(commit.message).toBe('Start the onboarding policy');
    expect(commit.files[0].content).toBe('# Written by hand\n\nBody.\n');
  });

  it('records the change as a new file with no "before"', async () => {
    // The viewer renders this as "New file" rather than "Manual edit", and a
    // `before` with content in it would show the whole document as a deletion.
    await create();

    const record = (buildContextFile.mock.calls[0][0] as unknown as { record: Record<string, unknown> }).record;
    expect(record).toMatchObject({
      type: 'new-file',
      knowledge: '',
      messages: [],
      diff: { before: '', after: '# new doc\n' },
    });
    // The `source` says only where it was typed: there is no thread and no
    // Google Doc behind a document someone wrote in the viewer. An import goes
    // through this same call and adds which source it came from on top.
    expect(record.source).toEqual({ editor: 'web' });
  });

  it('carries an import’s assets in the same commit as the document', async () => {
    // Committed separately, the document would be live on GitHub for as long as
    // the second commit took — and forever, if it failed — pointing at images
    // that are not in the repository.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await create({
      content: '# Imported\n\n![a picture](assets/abc123.png)\n',
      assets: [{ path: 'assets/abc123.png', bytes, contentType: 'image/png' }],
      source: { import: 'url', name: 'Example page', url: 'https://example.com/page' },
    });

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as {
      files: Array<{ path: string; content: string; encoding?: string }>;
    };
    expect(commit.files[0].path).toBe('policy/new-doc.md');
    // Base64, not utf-8: the bytes would otherwise be committed as literal text.
    expect(commit.files).toContainEqual({
      path: 'assets/abc123.png',
      content: bytes.toString('base64'),
      encoding: 'base64',
    });
    expect(fs.readFileSync(path.join(repoRoot, 'assets/abc123.png'))).toEqual(bytes);

    const record = (buildContextFile.mock.calls[0][0] as unknown as { record: Record<string, unknown> }).record;
    expect(record.source).toEqual({
      editor: 'web',
      import: 'url',
      name: 'Example page',
      url: 'https://example.com/page',
    });
  });

  it('refuses an asset path that is not under assets/, before committing', async () => {
    await expect(
      create({
        assets: [{ path: '../../etc/evil.png', bytes: Buffer.from('x'), contentType: 'image/png' }],
      }),
    ).rejects.toThrow(/outside assets\//);
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('reports its phases in order, and survives a listener that throws', async () => {
    const steps: string[] = [];
    await create({
      onStep: (step) => {
        steps.push(step);
        // Progress is decoration on work that has already happened; a closed
        // stream must not fail the save.
        throw new Error('listener exploded');
      },
    });

    expect(steps).toEqual(['checking', 'committing', 'mirroring', 'indexing', 'done']);
  });
});
