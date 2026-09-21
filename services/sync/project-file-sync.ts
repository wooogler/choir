/**
 * Bringing `.choir/project.json` into the mirror alongside the markdown.
 *
 * The mirror is not a git clone: `syncMarkdownFiles` writes exactly the files
 * it is handed, and it is only ever handed `.md`. That was fine while the only
 * non-markdown file in the repository was written by CHOIR itself — the project
 * GUI commits to GitHub *and* writes the mirror, so the file is there.
 *
 * It is not fine for the two cases that matter: a fresh instance pointed at an
 * existing repository, and a project file edited on GitHub. Neither has ever
 * passed through the GUI, so without this the folder is simply not a project
 * and its channels answer questions workspace-wide.
 *
 * Scope: project settings only. `.choir/context/**` (provenance) is deliberately
 * left out — it is one encrypted sidecar per commit, so fetching all of it on
 * every sync would cost a blob request per document change ever made, and the
 * viewer already reads those from GitHub on demand. Widening this is a change
 * to `isProjectFile` below, nothing more.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { GithubService } from 'services/github';
import { PROJECT_FILE } from 'services/projects/schema';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';

/**
 * A repository with more project folders than this is a misconfiguration, not
 * a workload — the cap keeps one bad tree from turning a sync into thousands
 * of blob requests.
 */
const MAX_PROJECT_FILES = 200;

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

export interface ProjectFileSyncResult {
  written: string[];
  removed: string[];
}

/** `<folder>/.choir/project.json`, never the repository root's own `.choir/`. */
export function isProjectFile(filePath: string): boolean {
  const normalized = filePath.replace(/^\/+/, '');
  if (!normalized.endsWith(`/${PROJECT_FILE}`)) return false;
  // A folder must remain above it: `.choir/project.json` at the root would
  // declare the whole repository a project, which `normalizeProjectFolder`
  // refuses anyway.
  return normalized.length > PROJECT_FILE.length + 1;
}

/**
 * Fetches every project file from the repository tree and makes the mirror
 * match it. `full` also deletes the mirrored files GitHub no longer has; an
 * incremental caller (a webhook for one changed document) leaves them alone.
 *
 * The caller invalidates the project index afterwards — one invalidation for
 * the whole sync, after the markdown too.
 */
export async function syncProjectFiles(params: {
  workspaceId: string;
  owner: string;
  repo: string;
  branch?: string;
  full?: boolean;
}): Promise<ProjectFileSyncResult> {
  const mirror = WorkspaceMirrorService.getInstance();

  const files = await GithubService.getInstance().getMatchingFiles({
    owner: params.owner,
    repo: params.repo,
    ref: params.branch,
    workspaceId: params.workspaceId,
    match: isProjectFile,
    maxFiles: MAX_PROJECT_FILES,
  });

  const written: string[] = [];
  for (const file of files) {
    const relativePath = file.path.replace(/^\/+/, '');
    try {
      await mirror.writeContextFile(params.workspaceId, relativePath, file.content);
      written.push(relativePath);
    } catch (error) {
      Logger.warn(`Project file sync could not write ${relativePath}`, error as Error);
    }
  }

  const removed: string[] = [];
  if (params.full !== false) {
    const expected = new Set(written);
    for (const stale of await mirroredProjectFiles(mirror.getRepoRoot(params.workspaceId))) {
      if (expected.has(stale)) continue;
      try {
        await mirror.removeContextFile(params.workspaceId, stale);
        removed.push(stale);
      } catch (error) {
        Logger.warn(`Project file sync could not remove ${stale}`, error as Error);
      }
    }
  }

  if (written.length > 0 || removed.length > 0) {
    Logger.info('Project file sync updated the mirror', {
      workspaceId: params.workspaceId,
      written: written.length,
      removed: removed.length,
    });
  }

  return { written, removed };
}

/** Every `**​/.choir/project.json` already in the mirror, repository-relative. */
async function mirroredProjectFiles(repoRoot: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (absolute: string, relative: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      // A workspace that has never synced has no mirror; that is an empty list.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        Logger.warn('Project file sync could not read a mirror directory', { absolute, error: String(error) });
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;

      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === '.choir') {
        if (relative && (await isFile(path.join(absolute, entry.name, 'project.json')))) {
          found.push(`${relative}/${PROJECT_FILE}`);
        }
        continue;
      }

      await walk(path.join(absolute, entry.name), childRelative);
    }
  };

  await walk(repoRoot, '');
  return found;
}

async function isFile(absolute: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(absolute)).isFile();
  } catch {
    return false;
  }
}
