import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { replicaLock, workspaceKey } from './keyed-mutex';
import type { GdocsDocState, GdocsSyncFile } from './types';

/**
 * Reads and writes the replica sync bookkeeping under
 * `data/workspaces/<id>/state/`, alongside the existing `sync-state.json`.
 *
 * All writes go through the process-wide workspace lock and land via a temp file
 * plus rename: several documents share one JSON file, so two documents' state
 * updates would otherwise interleave and lose one another.
 */

const SYNC_FILE = 'gdocs-sync.json';
const BASELINE_DIR = 'gdocs-baselines';

function stateRoot(workspaceId: string): string {
  // Delegated so the workspaceId path-traversal guard is applied in one place.
  return path.join(WorkspaceMirrorService.getInstance().getWorkspaceRoot(workspaceId), 'state');
}

function syncFilePath(workspaceId: string): string {
  return path.join(stateRoot(workspaceId), SYNC_FILE);
}

function baselineDir(workspaceId: string): string {
  return path.join(stateRoot(workspaceId), BASELINE_DIR);
}

/**
 * Baselines are named by hash rather than by path: a repo path contains slashes
 * and arbitrary characters, and hashing sidesteps both nesting and traversal.
 */
function baselinePath(workspaceId: string, githubPath: string): string {
  const digest = crypto.createHash('sha256').update(githubPath).digest('hex');
  return path.join(baselineDir(workspaceId), `${digest}.md`);
}

/** The repository markdown that produced the baseline, kept beside it. */
function sourceSnapshotPath(workspaceId: string, githubPath: string): string {
  const digest = crypto.createHash('sha256').update(githubPath).digest('hex');
  return path.join(baselineDir(workspaceId), `${digest}.source.md`);
}

function emptyFile(): GdocsSyncFile {
  return { version: 1, docs: {}, updatedAt: new Date().toISOString() };
}

async function readSyncFile(workspaceId: string): Promise<GdocsSyncFile> {
  const filePath = syncFilePath(workspaceId);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as GdocsSyncFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.docs) {
      return emptyFile();
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A corrupt file must not read as "no documents are mapped", which would
      // silently disable drift detection for the whole workspace.
      Logger.error(`Google Docs sync state unreadable for ${workspaceId}`, error as Error);
    }
    return emptyFile();
  }
}

async function writeSyncFile(workspaceId: string, file: GdocsSyncFile): Promise<void> {
  const dir = stateRoot(workspaceId);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = syncFilePath(workspaceId);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.promises.rename(temp, target);
}

export async function getDocState(workspaceId: string, githubPath: string): Promise<GdocsDocState | null> {
  const file = await readSyncFile(workspaceId);
  return file.docs[githubPath] ?? null;
}

export async function getAllDocStates(workspaceId: string): Promise<Record<string, GdocsDocState>> {
  const file = await readSyncFile(workspaceId);
  return file.docs;
}

/**
 * Atomically read-modify-writes one document's state. The mutator receives the
 * current state (or null when the document has none yet) and returns the state to
 * persist, or null to delete the entry.
 */
export async function mutateDocState(
  workspaceId: string,
  githubPath: string,
  mutator: (current: GdocsDocState | null) => GdocsDocState | null,
): Promise<GdocsDocState | null> {
  return replicaLock.run(workspaceKey(workspaceId), async () => {
    const file = await readSyncFile(workspaceId);
    const next = mutator(file.docs[githubPath] ?? null);

    if (next === null) {
      delete file.docs[githubPath];
    } else {
      file.docs[githubPath] = { ...next, updatedAt: new Date().toISOString() };
    }

    file.updatedAt = new Date().toISOString();
    await writeSyncFile(workspaceId, file);
    return next === null ? null : file.docs[githubPath];
  });
}

export async function removeDocState(workspaceId: string, githubPath: string): Promise<void> {
  await mutateDocState(workspaceId, githubPath, () => null);
  await removeBaseline(workspaceId, githubPath);
}

/**
 * The markdown export taken immediately after a push. Drift is `current export
 * !== baseline`; a missing baseline is not "no drift" but "cannot tell", which
 * callers must surface as `baseline-lost` rather than silently republishing over
 * whatever a human wrote.
 */
export async function readBaseline(workspaceId: string, githubPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(baselinePath(workspaceId, githubPath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      Logger.error(`Google Docs baseline unreadable for ${workspaceId}:${githubPath}`, error as Error);
    }
    return null;
  }
}

export async function writeBaseline(workspaceId: string, githubPath: string, content: string): Promise<void> {
  const dir = baselineDir(workspaceId);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = baselinePath(workspaceId, githubPath);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, content, 'utf-8');
  await fs.promises.rename(temp, target);
}

export async function removeBaseline(workspaceId: string, githubPath: string): Promise<void> {
  await fs.promises.rm(baselinePath(workspaceId, githubPath), { force: true });
  await fs.promises.rm(sourceSnapshotPath(workspaceId, githubPath), { force: true });
}

/**
 * The GitHub markdown that produced the current baseline.
 *
 * Delta extraction needs both halves of the same moment. The baseline is in
 * Docs' export dialect and the repository is in GitHub's, and the two differ
 * everywhere — escaped punctuation, hard-break spaces, code fences that do not
 * survive the round trip. Diffing across that gap marks every line as changed.
 * Keeping the source snapshot gives a line-by-line correspondence between the
 * dialects, so a human's edit can be carried back into repository markdown.
 */
export async function readSourceSnapshot(workspaceId: string, githubPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(sourceSnapshotPath(workspaceId, githubPath), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      Logger.error(`Google Docs source snapshot unreadable for ${workspaceId}:${githubPath}`, error as Error);
    }
    return null;
  }
}

export async function writeSourceSnapshot(workspaceId: string, githubPath: string, markdown: string): Promise<void> {
  await fs.promises.mkdir(baselineDir(workspaceId), { recursive: true });
  const target = sourceSnapshotPath(workspaceId, githubPath);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, markdown, 'utf-8');
  await fs.promises.rename(temp, target);
}

/** Stable hash of the GitHub markdown, used to skip pushes that would be no-ops. */
export function contentHash(markdown: string): string {
  return crypto.createHash('sha256').update(markdown).digest('hex');
}
