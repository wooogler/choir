/**
 * Every import — a Google Doc, a PDF, a web page — lands as a new repository
 * document through the same call the viewer's "New document" uses. This file
 * pins what that sharing bought and what it must not cost:
 *
 * - the images an import carries ride in the SAME commit as the markdown, so the
 *   document is never live on GitHub pointing at files that are not there;
 * - the document is indexed on the way in (the Google Docs import used to commit
 *   and mirror and leave Q&A blind to the new document until the next sync);
 * - provenance records where the document came from;
 * - and the import's own vocabulary — `exists`, `invalid-path`, its progress
 *   steps — is unchanged, because the route and the viewer speak it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A one-pixel PNG, so the extractor's magic-byte sniffing sees a real image.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const commitFilesWithContext = jest.fn(async () => ({ commitSha: 'cafebabe1234' }));
const getFile = jest.fn(async (): Promise<{ content: string; sha: string } | null> => null);
const readMirrorFile = jest.fn(async (): Promise<string | null> => null);
const buildContextFile = jest.fn(async () => ({ path: '.choir/context/a.json.enc', content: 'v1:enc' }));
const setLoadedMarkdownFiles = jest.fn();
const scheduleQmdWarmup = jest.fn();
const schedulePublish = jest.fn();
const seedReplica = jest.fn(async () => ({ outcome: 'seeded' }));
const setGoogleDocMapping = jest.fn(async () => undefined);
const getDocMeta = jest.fn(async () => ({
  name: 'Lab Handbook',
  webViewLink: 'https://docs.google.com/document/d/file-a/edit',
  trashed: false,
}));
const exportDocMarkdown = jest.fn(async () => '# Handbook\n\nWelcome\\.\n');

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-import-landing-'));

jest.mock('services/slack', () => ({
  getGithubRepo: jest.fn(async () => ({ owner: 'echo-lab', repo: 'assets', branch: 'main' })),
}));

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({ readMirrorFile, getRepoRoot: () => repoRoot, writeMarkdownFile: jest.fn() }),
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
      getMarkdownFile: () => undefined,
      getAllMarkdownFiles: () => [],
      setLoadedMarkdownFiles,
    }),
  },
}));

jest.mock('services/document/provenance', () => ({
  buildContextFile,
  persistContextToMirror: jest.fn(async () => undefined),
}));

jest.mock('services/document', () => ({ parseMarkdownToTree: () => ({ sections: [] }) }));
jest.mock('services/document/image-captions', () => ({ enrichWorkspaceImageCaptions: jest.fn(async () => undefined) }));
jest.mock('services/retrieval/warmup', () => ({ scheduleQmdWarmup }));

jest.mock('services/google/replica-publisher', () => ({
  schedulePublish,
  seedReplica,
  bannerLanguage: jest.fn(async () => 'en'),
}));

jest.mock('services/google/drive-client', () => ({ getDocMeta, exportDocMarkdown }));
jest.mock('services/google/google-auth-service', () => ({ getWorkspaceClient: jest.fn(async () => ({})) }));
jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: class {
    setGoogleDocMapping = setGoogleDocMapping;
  },
}));

import { importGoogleDoc } from '../services/google/import-service';

type CommitCall = {
  message: string;
  files: Array<{ path: string; content: string; encoding?: string }>;
};

type ProvenanceCall = { record: { type: string; source?: Record<string, unknown>; diff: { before: string } } };

const runImport = (overrides: Partial<Parameters<typeof importGoogleDoc>[0]> = {}) =>
  importGoogleDoc({
    workspaceId: 'T1',
    githubPath: 'policy/handbook.md',
    fileId: 'file-a',
    userId: 'U1',
    ...overrides,
  });

describe('Google Docs import lands through createDocument', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readMirrorFile.mockResolvedValue(null);
    getFile.mockResolvedValue(null);
    commitFilesWithContext.mockResolvedValue({ commitSha: 'cafebabe1234' });
    seedReplica.mockResolvedValue({ outcome: 'seeded' });
    exportDocMarkdown.mockResolvedValue('# Handbook\n\nWelcome\\.\n');
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('commits the markdown, keeps the commit message, and links the Doc', async () => {
    await expect(runImport()).resolves.toMatchObject({
      outcome: 'imported',
      githubPath: 'policy/handbook.md',
      commitSha: 'cafebabe1234',
      linked: true,
    });

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as CommitCall;
    expect(commit.message).toBe('Import handbook.md from Google Docs (Lab Handbook)');
    // The export's markdown escaping is committed as-is; the import transcribes
    // the Doc rather than rewriting it.
    expect(commit.files[0]).toEqual({ path: 'policy/handbook.md', content: '# Handbook\n\nWelcome\\.\n' });
    expect(setGoogleDocMapping).toHaveBeenCalledWith(
      'T1',
      'policy/handbook.md',
      expect.objectContaining({ fileId: 'file-a', mode: 'preserve' }),
    );
  });

  it('carries the Doc’s images into the same commit and into the mirror', async () => {
    exportDocMarkdown.mockResolvedValue(
      ['# Handbook', '', '![a picture][image1]', '', `[image1]: <data:image/png;base64,${PNG_BASE64}>`].join('\n'),
    );

    await expect(runImport()).resolves.toMatchObject({ outcome: 'imported' });

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as CommitCall;
    const asset = commit.files.find((file) => file.path.startsWith('assets/'));
    expect(asset).toBeDefined();
    // Base64: committed as utf-8 the bytes would land as literal base64 text.
    expect(asset?.encoding).toBe('base64');
    expect(asset?.content).toBe(PNG_BASE64);
    // And on disk, where the viewer serves images from.
    expect(fs.existsSync(path.join(repoRoot, asset?.path ?? 'missing'))).toBe(true);
    expect(commit.files[0].content).toContain(`(${asset?.path})`);
  });

  it('indexes the new document instead of leaving Q&A blind to it', async () => {
    // The gap this refactor closed: the import used to commit and mirror only,
    // so a freshly imported document was unsearchable until the next full sync.
    await runImport();

    expect(setLoadedMarkdownFiles).toHaveBeenCalledWith(
      [expect.objectContaining({ path: 'policy/handbook.md' })],
      'T1',
    );
    expect(scheduleQmdWarmup).toHaveBeenCalled();
  });

  it('records the creation with the Doc it came from', async () => {
    await runImport();

    const { record } = buildContextFile.mock.calls[0][0] as unknown as ProvenanceCall;
    expect(record.type).toBe('new-file');
    // Nothing was there before, so the viewer renders a creation rather than a
    // change list restating the whole document.
    expect(record.diff.before).toBe('');
    expect(record.source).toEqual({
      editor: 'web',
      import: 'google-docs',
      name: 'Lab Handbook',
      url: 'https://docs.google.com/document/d/file-a/edit',
      fileId: 'file-a',
    });
  });

  it('does not publish to the replica it is about to link', async () => {
    // The document is linked in `preserve` mode immediately below the landing.
    // A publish racing that linking would file an "apply this by hand" request
    // for content the Doc already holds.
    await runImport();

    expect(schedulePublish).not.toHaveBeenCalled();
  });

  it('reports the steps the viewer’s catalog knows, in order', async () => {
    const steps: string[] = [];
    await runImport({ onProgress: (progress) => steps.push(progress.step) });

    // 'indexing' happens, but the import's step vocabulary has no word for it,
    // so it is not forwarded as an unknown step.
    expect(steps).toEqual(['checking', 'reading', 'committing', 'mirroring', 'linking', 'done']);
  });

  it('answers `exists` when only GitHub knows the path is taken', async () => {
    // The mirror is a cache: a missed webhook or a fresh install leaves it
    // saying "absent" about a document that exists. The landing asks GitHub, and
    // its refusal has to come back as this import's own word for it.
    getFile.mockResolvedValue({ content: '# live on GitHub', sha: 'abc123' });

    await expect(runImport()).resolves.toMatchObject({
      outcome: 'exists',
      detail: 'policy/handbook.md already exists in this repository',
    });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
    expect(setGoogleDocMapping).not.toHaveBeenCalled();
  });

  it('answers `exists` from the mirror without reading the Doc at all', async () => {
    readMirrorFile.mockResolvedValue('# already here');

    await expect(runImport()).resolves.toMatchObject({ outcome: 'exists' });
    expect(exportDocMarkdown).not.toHaveBeenCalled();
  });

  it('refuses an unusable path before spending a Drive round trip', async () => {
    await expect(runImport({ githubPath: 'assets/evil.md' })).resolves.toMatchObject({ outcome: 'invalid-path' });
    await expect(runImport({ githubPath: '../outside.md' })).resolves.toMatchObject({ outcome: 'invalid-path' });

    expect(getDocMeta).not.toHaveBeenCalled();
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('still reports an empty export as empty, without committing', async () => {
    exportDocMarkdown.mockResolvedValue('   \n');

    await expect(runImport()).resolves.toMatchObject({ outcome: 'empty' });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });
});
