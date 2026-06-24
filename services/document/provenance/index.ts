import crypto from 'node:crypto';
import { Logger } from 'services/common/logger';
import { encryptStringWithKey } from 'services/db/crypto';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import type { ProvenanceRecord } from './types';

export * from './types';
export * from './read';

const CONTEXT_DIR = '.choir/context';

/**
 * Repo-relative path for a context sidecar. Mirrors the document path so a file's
 * history is a single folder listing; timestamp sorts, random suffix avoids
 * collisions (the record can't embed its own commit SHA — it's part of that commit).
 */
export function contextFilePath(docPath: string): string {
  const normalized = docPath.replace(/^\/+/, '').replace(/\.\.+/g, '');
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `${CONTEXT_DIR}/${normalized}/${stamp}-${rand}.json.enc`;
}

/**
 * Encrypt a provenance record with the workspace's context key and return a
 * committable sidecar file `{ path, content }`. The key is generated on first use.
 */
export async function buildContextFile(params: {
  workspaceId: string;
  docPath: string;
  record: ProvenanceRecord;
}): Promise<{ path: string; content: string }> {
  const key = await new WorkspaceStore().getOrCreateContextKey(params.workspaceId);
  const content = encryptStringWithKey(JSON.stringify(params.record), key);
  return { path: contextFilePath(params.docPath), content };
}

/**
 * Optimistically write a just-committed context sidecar into the local mirror so
 * the viewer can read it immediately (the markdown sync does not pull
 * `.choir/context/`). Best-effort: a failure only delays visibility until the
 * next full sync repopulates it from GitHub.
 */
export async function persistContextToMirror(
  workspaceId: string,
  contextFile: { path: string; content: string },
): Promise<void> {
  try {
    await WorkspaceMirrorService.getInstance().writeContextFile(workspaceId, contextFile.path, contextFile.content);
  } catch (error) {
    Logger.warn('persistContextToMirror failed; viewer will pick it up on next sync', error as Error);
  }
}
