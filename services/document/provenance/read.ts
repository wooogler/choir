import fs from 'node:fs';
import path from 'node:path';
import { decryptStringWithKey } from 'services/db/crypto';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import type { ProvenanceRecord } from './types';

// The list endpoint returns full records (record counts per doc are small and the
// panel needs conversation/diff text for client-side search, sort and filtering).
export type ProvenanceListItem = ProvenanceRecord & { id: string };

const RECORD_ID = /^[\w.-]+\.json\.enc$/;

/** Resolve the mirror folder holding a document's context records, safely. */
function contextDirFor(workspaceId: string, docPath: string): string {
  const repoRoot = WorkspaceMirrorService.getInstance().getRepoRoot(workspaceId);
  const normalized = path.posix.normalize(docPath).replace(/^\/+/, '');
  const dir = path.resolve(repoRoot, '.choir/context', normalized);
  if (!dir.startsWith(path.resolve(repoRoot, '.choir/context'))) {
    throw new Error('Forbidden context path');
  }
  return dir;
}

/**
 * Decrypt every context record for a document, newest first. Records that fail to
 * decrypt (orphaned by a key rotation, or corrupt) are skipped, not fatal.
 */
async function readRecords(
  workspaceId: string,
  docPath: string,
): Promise<Array<{ id: string; record: ProvenanceRecord }>> {
  const key = await new WorkspaceStore().getContextEncryptionKey(workspaceId);
  if (!key) return [];

  const dir = contextDirFor(workspaceId, docPath);
  if (!fs.existsSync(dir)) return [];

  const entries = await fs.promises.readdir(dir);
  const out: Array<{ id: string; record: ProvenanceRecord }> = [];
  for (const name of entries) {
    if (!RECORD_ID.test(name)) continue;
    try {
      const enc = (await fs.promises.readFile(path.join(dir, name), 'utf-8')).trim();
      out.push({ id: name, record: JSON.parse(decryptStringWithKey(enc, key)) as ProvenanceRecord });
    } catch {
      // orphaned (rotated key) or corrupt — skip
    }
  }

  out.sort((a, b) => (b.record.createdAt || b.id).localeCompare(a.record.createdAt || a.id));
  return out;
}

export async function listProvenanceForDoc(workspaceId: string, docPath: string): Promise<ProvenanceListItem[]> {
  const records = await readRecords(workspaceId, docPath);
  return records.map(({ id, record }) => ({ id, ...record }));
}

export async function getProvenanceRecord(
  workspaceId: string,
  docPath: string,
  id: string,
): Promise<ProvenanceRecord | null> {
  if (!RECORD_ID.test(id)) return null;

  const key = await new WorkspaceStore().getContextEncryptionKey(workspaceId);
  if (!key) return null;

  const file = path.join(contextDirFor(workspaceId, docPath), id);
  if (!fs.existsSync(file)) return null;

  try {
    const enc = (await fs.promises.readFile(file, 'utf-8')).trim();
    return JSON.parse(decryptStringWithKey(enc, key)) as ProvenanceRecord;
  } catch {
    return null;
  }
}
