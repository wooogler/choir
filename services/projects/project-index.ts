import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { PROJECT_FILE, type ProjectSettings, normalizeProjectFolder, parseProjectSettings } from './schema';

/**
 * Which folders of a workspace's repository are projects, and which Slack
 * channel belongs to which.
 *
 * Built by walking the mirror rather than by reading a server-side registry:
 * the metadata lives in the repository (docs/project-folders.md 1), so a folder
 * renamed or moved on GitHub carries its project with it and the index is
 * simply rebuilt. That makes the walk the source of truth and the cache below
 * a 60-second optimisation, not state.
 *
 * Callers that change the repository — the project store here, and the mirror
 * sync paths — must call `invalidateProjectIndex` so the next question is
 * answered against the new tree rather than up to a minute of stale mapping.
 */

export interface ProjectRecord {
  /** Repository-relative folder, e.g. `projects/alpha`. Never `''`. */
  folder: string;
  settings: ProjectSettings;
}

export interface BrokenProjectFile {
  folder: string;
  /** Why the file was skipped, in English, for the GUI to show next to "re-save to overwrite". */
  error: string;
}

export interface ProjectIndex {
  byFolder: Map<string, ProjectSettings>;
  /** Channel ID → project folder. One channel belongs to one project. */
  byChannel: Map<string, string>;
  broken: BrokenProjectFile[];
}

/** How long a built index is reused before the mirror is walked again. */
export const PROJECT_INDEX_TTL_MS = 60_000;

/** Directories that are never part of the documentation tree. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

interface CacheEntry {
  builtAt: number;
  index: ProjectIndex;
}

const cache = new Map<string, CacheEntry>();

/** Drops the cached index so the next read walks the mirror again. */
export function invalidateProjectIndex(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test seam: forget every workspace's index. */
export function clearProjectIndexCache(): void {
  cache.clear();
}

export async function getProjectIndex(workspaceId: string): Promise<ProjectIndex> {
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.builtAt < PROJECT_INDEX_TTL_MS) {
    return cached.index;
  }

  const index = await buildProjectIndex(workspaceId);
  cache.set(workspaceId, { builtAt: Date.now(), index });
  return index;
}

async function buildProjectIndex(workspaceId: string): Promise<ProjectIndex> {
  const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(workspaceId);
  const byFolder = new Map<string, ProjectSettings>();
  const byChannel = new Map<string, string>();
  const broken: BrokenProjectFile[] = [];

  // Sorted so a channel claimed by two folders — only reachable by editing the
  // files by hand, since the store refuses it — always resolves to the same one.
  const folders = (await findProjectFolders(repoRoot)).sort();

  for (const folder of folders) {
    const filePath = path.join(repoRoot, folder, PROJECT_FILE);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      broken.push({ folder, error: `could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'})` });
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      broken.push({ folder, error: `is not valid JSON (${(error as Error).message})` });
      continue;
    }

    const parsed = parseProjectSettings(json);
    if (!parsed.ok) {
      broken.push({ folder, error: parsed.message });
      continue;
    }

    byFolder.set(folder, parsed.value);
    for (const channel of parsed.value.channels) {
      if (!byChannel.has(channel)) byChannel.set(channel, folder);
    }
  }

  return { byFolder, byChannel, broken };
}

/**
 * Every folder holding a `.choir/project.json`, repository-relative.
 *
 * The mirror is a git clone, so a plain directory walk is enough — there is no
 * build output or dependency tree to glob around, only `.git` itself. A folder
 * the normalizer refuses (the repository root, anything under `assets/` or
 * `.choir/`) is skipped silently: it is not a broken project file, it is a
 * place a project cannot be.
 */
async function findProjectFolders(repoRoot: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (absolute: string, relative: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      // A workspace that has never synced has no mirror at all; that is an
      // empty index, not a failure the caller should see.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        Logger.warn('Project index could not read a mirror directory', { absolute, error: String(error) });
      }
      return;
    }

    if (relative && entries.some((entry) => entry.isDirectory() && entry.name === '.choir')) {
      const folder = normalizeProjectFolder(relative);
      if (folder && (await isFile(path.join(absolute, PROJECT_FILE)))) found.push(folder);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      // `.choir/` holds metadata, never a nested project.
      if (entry.name === '.choir') continue;
      await walk(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
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

export async function listProjects(workspaceId: string): Promise<ProjectRecord[]> {
  const index = await getProjectIndex(workspaceId);
  return [...index.byFolder.entries()].map(([folder, settings]) => ({ folder, settings }));
}

export async function getProject(workspaceId: string, folder: string): Promise<ProjectRecord | null> {
  const normalized = normalizeProjectFolder(folder);
  if (!normalized) return null;

  const index = await getProjectIndex(workspaceId);
  const settings = index.byFolder.get(normalized);
  return settings ? { folder: normalized, settings } : null;
}

/**
 * The project a document belongs to: the nearest ancestor folder that is one.
 *
 * Nearest rather than outermost, so a project nested inside another wins for
 * its own documents — the same rule the glossary chain uses
 * (docs/project-folders.md 2).
 */
export async function resolveProjectForPath(workspaceId: string, docPath: string): Promise<ProjectRecord | null> {
  const index = await getProjectIndex(workspaceId);
  if (index.byFolder.size === 0) return null;

  const segments = docPath
    .trim()
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  // Longest prefix first. The full path is included so a folder passed in
  // resolves to itself rather than to its parent project.
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const candidate = segments.slice(0, depth).join('/');
    const settings = index.byFolder.get(candidate);
    if (settings) return { folder: candidate, settings };
  }
  return null;
}

export async function resolveProjectForChannel(workspaceId: string, channelId: string): Promise<ProjectRecord | null> {
  const index = await getProjectIndex(workspaceId);
  const folder = index.byChannel.get(channelId);
  if (!folder) return null;

  const settings = index.byFolder.get(folder);
  return settings ? { folder, settings } : null;
}

export async function brokenProjectFiles(workspaceId: string): Promise<BrokenProjectFile[]> {
  return (await getProjectIndex(workspaceId)).broken;
}
