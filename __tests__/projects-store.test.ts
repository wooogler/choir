/**
 * What the store is responsible for: the exact bytes and path it commits, the
 * one refusal that protects the channel→project mapping, and the fact that a
 * delete is a deletion in the same commit machinery rather than a second kind
 * of write.
 *
 * GitHub and the mirror are mocked; the index is the real one, reading a temp
 * directory, because the channel-taken check is exactly the interplay between
 * the two.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let repoRoot = '';

const commitFilesWithContext = jest.fn(async () => ({ commitSha: 'sha-1' }));
const writeContextFile = jest.fn(async () => '/tmp/written');
const removeMarkdownFile = jest.fn(async () => undefined);

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({ getRepoRoot: () => repoRoot, writeContextFile, removeMarkdownFile }),
  },
}));
jest.mock('services/github', () => ({
  GithubService: { getInstance: () => ({ commitFilesWithContext }) },
}));
jest.mock('services/slack', () => ({
  getGithubRepo: jest.fn(async () => ({ owner: 'acme', repo: 'docs', branch: 'main' })),
}));

import { clearProjectIndexCache, listProjects } from '../services/projects/project-index';
import { ProjectRefusal, deleteProject, saveProject } from '../services/projects/project-store';

const WS = 'T1';
const USER = 'U-manager';

function writeProject(folder: string, body: unknown): void {
  const dir = path.join(repoRoot, folder, '.choir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(body));
}

beforeEach(() => {
  jest.clearAllMocks();
  commitFilesWithContext.mockResolvedValue({ commitSha: 'sha-1' });
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-project-store-'));
  clearProjectIndexCache();
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('saveProject', () => {
  it('commits the settings under the project folder and mirrors them', async () => {
    const result = await saveProject({
      workspaceId: WS,
      userId: USER,
      folder: 'projects/alpha/',
      settings: { name: 'Alpha', channels: ['C0AA'] },
    });

    expect(result.commitSha).toBe('sha-1');
    expect(result.project.folder).toBe('projects/alpha');

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as {
      owner: string;
      repo: string;
      branch: string;
      message: string;
      files: Array<{ path: string; content: string }>;
      workspaceId: string;
      userId: string;
    };
    expect(commit).toMatchObject({ owner: 'acme', repo: 'docs', branch: 'main', workspaceId: WS, userId: USER });
    expect(commit.message).toBe('Update project settings: projects/alpha');
    expect(commit.files).toHaveLength(1);
    expect(commit.files[0].path).toBe('projects/alpha/.choir/project.json');
    expect(JSON.parse(commit.files[0].content)).toEqual({
      version: 1,
      name: 'Alpha',
      description: '',
      channels: ['C0AA'],
      members: { source: 'channels', curated: [], aliases: {} },
      scope: { retrieval: 'boost', updates: 'folder' },
      meetingsFolder: 'meetings',
      glossary: 'GLOSSARY.md',
    });

    // The mirror gets the same bytes, or the index would rebuild from the old file.
    expect(writeContextFile).toHaveBeenCalledWith(WS, 'projects/alpha/.choir/project.json', commit.files[0].content);
  });

  it('lets a project keep its own channel when it is saved again', async () => {
    writeProject('projects/alpha', { name: 'Alpha', channels: ['C0AA'] });

    await expect(
      saveProject({
        workspaceId: WS,
        userId: USER,
        folder: 'projects/alpha',
        settings: { name: 'Alpha v2', channels: ['C0AA'] },
      }),
    ).resolves.toMatchObject({ commitSha: 'sha-1' });
  });

  it('refuses a channel that belongs to another project', async () => {
    writeProject('projects/alpha', { name: 'Alpha', channels: ['C0AA'] });

    const refusal = await saveProject({
      workspaceId: WS,
      userId: USER,
      folder: 'projects/beta',
      settings: { name: 'Beta', channels: ['C0BB', 'C0AA'] },
    }).catch((err) => err);

    expect(refusal).toBeInstanceOf(ProjectRefusal);
    expect(refusal.status).toBe(409);
    expect(refusal.apiCode).toBe('project_channel_taken');
    expect(refusal.detail).toEqual({ channel: 'C0AA', folder: 'projects/alpha' });
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('refuses an unusable folder and invalid settings before any commit', async () => {
    const badFolder = await saveProject({ workspaceId: WS, userId: USER, folder: '', settings: { name: 'A' } }).catch(
      (err) => err,
    );
    expect(badFolder.apiCode).toBe('project_folder_invalid');
    expect(badFolder.status).toBe(400);

    const badSettings = await saveProject({
      workspaceId: WS,
      userId: USER,
      folder: 'alpha',
      settings: { name: 'A', channels: ['nope'] },
    }).catch((err) => err);
    expect(badSettings.apiCode).toBe('project_invalid');
    expect(badSettings.detail).toEqual({ message: 'channels[0] is not a Slack channel ID' });

    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });

  it('invalidates the index so the next read sees the save', async () => {
    writeProject('alpha', { name: 'Alpha' });
    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['alpha']);

    // The mirror write is mocked, so stand in for it before the invalidation.
    writeContextFile.mockImplementation(async () => {
      writeProject('beta', { name: 'Beta' });
      return '/tmp/written';
    });
    await saveProject({ workspaceId: WS, userId: USER, folder: 'beta', settings: { name: 'Beta' } });

    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['alpha', 'beta']);
  });
});

describe('deleteProject', () => {
  it('removes the file in one commit and drops it from the mirror', async () => {
    writeProject('projects/alpha', { name: 'Alpha' });

    const result = await deleteProject({ workspaceId: WS, userId: USER, folder: 'projects/alpha' });
    expect(result).toEqual({ commitSha: 'sha-1', folder: 'projects/alpha' });

    const commit = commitFilesWithContext.mock.calls[0][0] as unknown as {
      message: string;
      files: unknown[];
      deletions: string[];
    };
    expect(commit.files).toEqual([]);
    expect(commit.deletions).toEqual(['projects/alpha/.choir/project.json']);
    expect(commit.message).toBe('Remove project settings: projects/alpha');
    expect(removeMarkdownFile).toHaveBeenCalledWith(WS, 'projects/alpha/.choir/project.json');
  });

  it('can remove a project whose file is broken', async () => {
    fs.mkdirSync(path.join(repoRoot, 'alpha', '.choir'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'alpha', '.choir', 'project.json'), '{ broken');

    await expect(deleteProject({ workspaceId: WS, userId: USER, folder: 'alpha' })).resolves.toMatchObject({
      folder: 'alpha',
    });
  });

  it('answers 404 for a folder that is not a project', async () => {
    const refusal = await deleteProject({ workspaceId: WS, userId: USER, folder: 'nowhere' }).catch((err) => err);
    expect(refusal).toBeInstanceOf(ProjectRefusal);
    expect(refusal.status).toBe(404);
    expect(refusal.apiCode).toBe('project_not_found');
    expect(commitFilesWithContext).not.toHaveBeenCalled();
  });
});
