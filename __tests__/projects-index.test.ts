import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The index is a walk of the mirror, so it is tested against a real directory
 * tree: nested projects, a file somebody broke by hand, and the cache that
 * stands between the walk and every question asked of it.
 *
 * Only `getRepoRoot` is mocked — pulling the real mirror service in would bring
 * the path map, the section splitter and a data directory with it.
 */

let repoRoot = '';

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({ getRepoRoot: () => repoRoot }),
  },
}));

import {
  brokenProjectFiles,
  clearProjectIndexCache,
  getProject,
  invalidateProjectIndex,
  listProjects,
  resolveProjectForChannel,
  resolveProjectForPath,
} from '../services/projects/project-index';

const WS = 'T1';

function writeProject(folder: string, body: unknown): void {
  const dir = path.join(repoRoot, folder, '.choir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-projects-'));
  clearProjectIndexCache();
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('the project index', () => {
  it('finds every .choir/project.json in the mirror', async () => {
    writeProject('projects/alpha', { name: 'Alpha', channels: ['C0AA'] });
    writeProject('projects/alpha/paper', { name: 'Alpha paper', channels: ['C0PP'] });
    writeProject('ops', { name: 'Ops' });
    fs.mkdirSync(path.join(repoRoot, '.git', 'refs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Docs');

    const projects = await listProjects(WS);
    expect(projects.map((p) => p.folder)).toEqual(['ops', 'projects/alpha', 'projects/alpha/paper']);
    expect(projects[1].settings.name).toBe('Alpha');
  });

  it('ignores a project file at the repository root — the root is not a project', async () => {
    writeProject('', { name: 'Everything' });
    writeProject('alpha', { name: 'Alpha' });

    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['alpha']);
    expect(await brokenProjectFiles(WS)).toEqual([]);
  });

  it('records a broken file and keeps indexing the rest', async () => {
    writeProject('alpha', '{ "name": "Alpha", ');
    writeProject('beta', { name: 'Beta', mystery: true });
    writeProject('gamma', { name: 'Gamma' });

    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['gamma']);
    const broken = await brokenProjectFiles(WS);
    expect(broken.map((entry) => entry.folder)).toEqual(['alpha', 'beta']);
    expect(broken[0].error).toMatch(/not valid JSON/);
    expect(broken[1].error).toBe('mystery is not a known setting');
  });

  it('resolves a document to its nearest ancestor project', async () => {
    writeProject('projects/alpha', { name: 'Alpha' });
    writeProject('projects/alpha/paper', { name: 'Alpha paper' });

    expect((await resolveProjectForPath(WS, 'projects/alpha/paper/draft.md'))?.folder).toBe('projects/alpha/paper');
    expect((await resolveProjectForPath(WS, 'projects/alpha/design.md'))?.folder).toBe('projects/alpha');
    // A folder resolves to itself rather than to its parent.
    expect((await resolveProjectForPath(WS, 'projects/alpha/paper'))?.folder).toBe('projects/alpha/paper');
    // Outside every project, and at the root, there is no project.
    expect(await resolveProjectForPath(WS, 'projects/other/notes.md')).toBeNull();
    expect(await resolveProjectForPath(WS, 'README.md')).toBeNull();
  });

  it('maps a channel to the project that claims it', async () => {
    writeProject('alpha', { name: 'Alpha', channels: ['C0AA', 'C0BB'] });
    writeProject('beta', { name: 'Beta', channels: ['C0CC'] });

    expect((await resolveProjectForChannel(WS, 'C0BB'))?.folder).toBe('alpha');
    expect((await resolveProjectForChannel(WS, 'C0CC'))?.settings.name).toBe('Beta');
    expect(await resolveProjectForChannel(WS, 'C0ZZ')).toBeNull();
  });

  it('gives a hand-edited double claim to the same project every time', async () => {
    writeProject('zeta', { name: 'Zeta', channels: ['C0AA'] });
    writeProject('alpha', { name: 'Alpha', channels: ['C0AA'] });

    expect((await resolveProjectForChannel(WS, 'C0AA'))?.folder).toBe('alpha');
  });

  it('normalizes the folder a lookup asks for, and refuses the root', async () => {
    writeProject('projects/alpha', { name: 'Alpha' });

    expect((await getProject(WS, '/projects/alpha/'))?.settings.name).toBe('Alpha');
    expect(await getProject(WS, '')).toBeNull();
    expect(await getProject(WS, 'projects/../projects/alpha')).toBeNull();
  });

  it('serves the cached index until it is invalidated', async () => {
    writeProject('alpha', { name: 'Alpha' });
    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['alpha']);

    writeProject('beta', { name: 'Beta' });
    // Within the TTL the new folder is invisible — that is the cache working.
    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['alpha']);

    invalidateProjectIndex(WS);
    expect((await listProjects(WS)).map((p) => p.folder)).toEqual(['alpha', 'beta']);
  });

  it('is an empty index when the workspace has never synced', async () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    expect(await listProjects(WS)).toEqual([]);
    expect(await brokenProjectFiles(WS)).toEqual([]);
  });
});
