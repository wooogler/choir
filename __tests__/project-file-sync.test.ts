import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `.choir/project.json` reaching the mirror from GitHub.
 *
 * The mirror is not a clone — `syncMarkdownFiles` writes exactly the `.md` it
 * is handed — so a project file that never passed through the viewer's GUI has
 * to be fetched on its own. The GitHub side is a fake tree; the mirror side is
 * a real directory, because "is the file on disk where the index walks" is the
 * whole question.
 */

let repoRoot = '';
let tree: Array<{ path: string; type: 'blob' | 'tree'; sha: string }> = [];
const blobs = new Map<string, string>();
const matchedPaths: string[] = [];

jest.mock('services/github', () => ({
  GithubService: {
    getInstance: () => ({
      getMatchingFiles: async (params: { match: (filePath: string) => boolean }) => {
        const picked = tree.filter((item) => item.type === 'blob' && params.match(item.path));
        matchedPaths.push(...picked.map((item) => item.path));
        return picked.map((item) => ({ path: item.path, content: blobs.get(item.path) ?? '' }));
      },
    }),
  },
}));

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({
      getRepoRoot: () => repoRoot,
      writeContextFile: async (_workspaceId: string, relativePath: string, content: string) => {
        const target = path.join(repoRoot, relativePath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, content, 'utf-8');
        return target;
      },
      removeContextFile: async (_workspaceId: string, relativePath: string) => {
        await fs.promises.rm(path.join(repoRoot, relativePath), { force: true });
      },
    }),
  },
}));

import { isProjectFile, syncProjectFiles } from 'services/sync/project-file-sync';

const WS = 'T1';

function blob(filePath: string, content: string): void {
  tree.push({ path: filePath, type: 'blob', sha: `sha-${filePath}` });
  blobs.set(filePath, content);
}

function settings(name: string): string {
  return JSON.stringify({ version: 1, name, channels: ['C0AB12CD3'] });
}

function mirrored(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function writeMirrored(relativePath: string, content: string): void {
  const target = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-project-sync-'));
  tree = [];
  blobs.clear();
  matchedPaths.length = 0;
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('isProjectFile', () => {
  it('matches a project file inside a folder', () => {
    expect(isProjectFile('projects/alpha/.choir/project.json')).toBe(true);
    expect(isProjectFile('a/b/c/.choir/project.json')).toBe(true);
  });

  it('does not match the repository root, which is never a project', () => {
    expect(isProjectFile('.choir/project.json')).toBe(false);
  });

  it('does not match documents or the provenance sidecars beside it', () => {
    expect(isProjectFile('projects/alpha/design.md')).toBe(false);
    expect(isProjectFile('.choir/context/abc123.json.enc')).toBe(false);
    expect(isProjectFile('projects/alpha/.choir/notes.json')).toBe(false);
  });
});

describe('syncProjectFiles', () => {
  it('fetches only the project files out of the tree', async () => {
    blob('README.md', '# Docs');
    blob('projects/alpha/design.md', '# Design');
    blob('projects/alpha/.choir/project.json', settings('Alpha'));
    blob('.choir/context/deadbeef.json.enc', 'encrypted');

    await syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs', branch: 'main' });

    expect(matchedPaths).toEqual(['projects/alpha/.choir/project.json']);
  });

  it('writes them into the mirror where the project index walks', async () => {
    blob('projects/alpha/.choir/project.json', settings('Alpha'));
    blob('projects/beta/.choir/project.json', settings('Beta'));

    const result = await syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs' });

    expect(result.written.sort()).toEqual(['projects/alpha/.choir/project.json', 'projects/beta/.choir/project.json']);
    expect(fs.readFileSync(path.join(repoRoot, 'projects/alpha/.choir/project.json'), 'utf-8')).toContain('Alpha');
    expect(mirrored('projects/beta/.choir/project.json')).toBe(true);
  });

  it('overwrites a mirrored file that changed on GitHub', async () => {
    writeMirrored('projects/alpha/.choir/project.json', settings('Old name'));
    blob('projects/alpha/.choir/project.json', settings('New name'));

    await syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs' });

    expect(fs.readFileSync(path.join(repoRoot, 'projects/alpha/.choir/project.json'), 'utf-8')).toContain('New name');
  });

  it('removes a mirrored project file the repository no longer has', async () => {
    writeMirrored('projects/gone/.choir/project.json', settings('Gone'));
    writeMirrored('projects/alpha/.choir/project.json', settings('Alpha'));
    blob('projects/alpha/.choir/project.json', settings('Alpha'));

    const result = await syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs' });

    expect(result.removed).toEqual(['projects/gone/.choir/project.json']);
    expect(mirrored('projects/gone/.choir/project.json')).toBe(false);
    expect(mirrored('projects/alpha/.choir/project.json')).toBe(true);
  });

  it('leaves everything else in the mirror alone', async () => {
    writeMirrored('projects/alpha/design.md', '# Design');
    writeMirrored('.choir/context/deadbeef.json.enc', 'encrypted');

    await syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs' });

    expect(mirrored('projects/alpha/design.md')).toBe(true);
    expect(mirrored('.choir/context/deadbeef.json.enc')).toBe(true);
  });

  it('keeps stale files when the caller asked for an incremental pass', async () => {
    writeMirrored('projects/gone/.choir/project.json', settings('Gone'));

    const result = await syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs', full: false });

    expect(result.removed).toEqual([]);
    expect(mirrored('projects/gone/.choir/project.json')).toBe(true);
  });

  it('does nothing at all for a workspace whose mirror has never been created', async () => {
    fs.rmSync(repoRoot, { recursive: true, force: true });

    await expect(syncProjectFiles({ workspaceId: WS, owner: 'acme', repo: 'docs' })).resolves.toEqual({
      written: [],
      removed: [],
    });
  });
});
