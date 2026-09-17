import crypto from 'node:crypto';
import path from 'node:path';
import { Logger } from 'services/common/logger';
import { ASSETS_DIR } from 'services/docs-editor/save-asset';
import { buildContextFile, persistContextToMirror } from 'services/document/provenance';
import type { ProvenanceRecord } from 'services/document/provenance/types';
import { GithubService } from 'services/github';
import { getGithubRepo } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { exportDocMarkdown, getDocMeta } from './drive-client';
import { type DeltaAsset, type DeltaConflict, type RejectedAsset, assetRepoPath, extractDelta } from './gdocs-delta';
import { getDocState, mutateDocState, readBaseline, readSourceSnapshot } from './gdocs-state';
import { getWorkspaceClient } from './google-auth-service';
import { docKey, replicaLock } from './keyed-mutex';
import { publishReplica } from './replica-publisher';

/**
 * Turns a drifted replica into something a manager can decide about, and carries
 * out the decision.
 *
 * Every destructive step is fenced. A review is rendered against a specific Doc
 * version and a specific repository blob; if either has moved by the time the
 * manager clicks, the decision is refused and the review is rebuilt. Without
 * that, approving a merge built minutes ago would erase a colleague's commit,
 * and rejecting would destroy an edit made after the review was rendered — in
 * both cases silently, because nobody ever saw the newer version.
 */

export interface ReviewPayload {
  githubPath: string;
  docUrl: string;
  status: 'ready' | 'no-change' | 'not-linked' | 'not-connected' | 'not-drifted' | 'baseline-lost';
  /** Repository markdown before the edit. */
  before?: string;
  /** Repository markdown with the edit applied where possible. */
  after?: string;
  conflicts?: DeltaConflict[];
  newAssets?: Array<{ hash: string; contentType: string; bytes: number }>;
  rejectedAssets?: RejectedAsset[];
  editor?: string;
}

export type DecisionOutcome =
  | 'committed'
  /** The commit landed but the replica could not be republished from it. */
  | 'committed-not-republished'
  | 'restored'
  /**
   * Preserve mode: the rejection was recorded and the baseline rebuilt, but the
   * document still holds the text that was turned down. Reverting it is a
   * person's job — CHOIR does not write that document's body.
   */
  | 'declined-not-restored'
  /** The document or the repository moved; the review was rebuilt. */
  | 'stale'
  | 'not-pending'
  | 'not-linked'
  | 'not-connected'
  | 'failed';

export interface DecisionResult {
  outcome: DecisionOutcome;
  commitSha?: string;
  detail?: string;
}

/**
 * Git's own blob identity: sha1 over "blob <len>\0<content>". Computing it here
 * rather than asking the API keeps the fence cheap enough to check on every
 * decision, and it is exactly the value GitHub reports for the file.
 */
function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf-8');
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
}

interface Materials {
  mapping: { fileId: string; webViewLink: string };
  auth: any;
  baseline: string;
  sourceAtPush: string;
  currentSource: string;
  exported: string;
  version?: string;
  editor?: string;
}

/** Everything a review or decision needs, or the reason it cannot proceed. */
async function gatherMaterials(
  workspaceId: string,
  githubPath: string,
): Promise<{ ok: true; materials: Materials } | { ok: false; status: ReviewPayload['status'] }> {
  const store = new WorkspaceStore();

  const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
  if (!mapping) return { ok: false, status: 'not-linked' };

  const auth = await getWorkspaceClient(workspaceId);
  if (!auth) return { ok: false, status: 'not-connected' };

  const [baseline, sourceAtPush, currentSource] = await Promise.all([
    readBaseline(workspaceId, githubPath),
    readSourceSnapshot(workspaceId, githubPath),
    WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath),
  ]);

  // Both halves are needed to bridge the export dialect; without either, the
  // edit cannot be expressed as repository markdown at all.
  if (baseline === null || sourceAtPush === null || currentSource === null) {
    return { ok: false, status: 'baseline-lost' };
  }

  const [exported, meta] = await Promise.all([
    exportDocMarkdown(auth, mapping.fileId),
    getDocMeta(auth, mapping.fileId),
  ]);

  return {
    ok: true,
    materials: {
      mapping,
      auth,
      baseline,
      sourceAtPush,
      currentSource,
      exported,
      version: meta.version,
      editor: meta.lastModifyingUser,
    },
  };
}

/**
 * Builds the review and records what it was rendered against. Recomputed on
 * every load rather than stored: the baseline, the export and the repository are
 * all re-readable, and a cached delta would go stale the moment any of them moves.
 */
export async function buildReview(workspaceId: string, githubPath: string): Promise<ReviewPayload> {
  return replicaLock.run(docKey(workspaceId, githubPath), async () => {
    const state = await getDocState(workspaceId, githubPath);
    if (!state || (state.status !== 'drifted' && state.status !== 'pending-review')) {
      return { githubPath, docUrl: '', status: 'not-drifted' as const };
    }

    const gathered = await gatherMaterials(workspaceId, githubPath);
    if (!gathered.ok) {
      return { githubPath, docUrl: '', status: gathered.status };
    }
    const { materials } = gathered;

    const delta = extractDelta({
      baseline: materials.baseline,
      exported: materials.exported,
      sourceAtPush: materials.sourceAtPush,
      currentSource: materials.currentSource,
    });

    if (!delta.hasChanges) {
      return { githubPath, docUrl: materials.mapping.webViewLink, status: 'no-change' as const };
    }

    // The fences the decision will be checked against.
    await mutateDocState(workspaceId, githubPath, (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'pending-review',
      reviewedVersion: materials.version,
      latestVersion: materials.version,
      oursBlobSha: gitBlobSha(materials.currentSource),
      lastModifyingUser: materials.editor,
      updatedAt: '',
    }));

    return {
      githubPath,
      docUrl: materials.mapping.webViewLink,
      status: 'ready' as const,
      before: materials.currentSource,
      after: delta.merged,
      conflicts: delta.conflicts,
      newAssets: delta.newAssets.map((asset) => ({
        hash: asset.hash,
        contentType: asset.contentType,
        bytes: asset.bytes.length,
      })),
      rejectedAssets: delta.rejectedAssets,
      editor: materials.editor,
    };
  });
}

export async function approveReview(params: {
  workspaceId: string;
  githubPath: string;
  userId: string;
  /** The manager's final text, which may differ from the proposal after editing. */
  content: string;
}): Promise<DecisionResult> {
  const { workspaceId, githubPath, userId } = params;

  const prepared = await replicaLock.run(docKey(workspaceId, githubPath), async () => {
    const state = await getDocState(workspaceId, githubPath);
    if (state?.status !== 'pending-review') {
      return { blocked: 'not-pending' as const };
    }

    const gathered = await gatherMaterials(workspaceId, githubPath);
    if (!gathered.ok) {
      return { blocked: gathered.status === 'not-linked' ? ('not-linked' as const) : ('not-connected' as const) };
    }

    // Someone committed to this file while the review was open. Committing the
    // manager's merge on top would erase their change without anyone seeing it.
    if (state.oursBlobSha && gitBlobSha(gathered.materials.currentSource) !== state.oursBlobSha) {
      return { blocked: 'stale' as const };
    }
    // And the Doc may have moved on. Approving republishes the manager's text
    // over the whole document, so writing that were more paragraphs added since
    // the review was rendered would vanish from the Doc and never reach the
    // commit either — destroyed without anyone having read them.
    if (state.reviewedVersion && gathered.materials.version !== state.reviewedVersion) {
      return { blocked: 'stale' as const };
    }

    const delta = extractDelta({
      baseline: gathered.materials.baseline,
      exported: gathered.materials.exported,
      sourceAtPush: gathered.materials.sourceAtPush,
      currentSource: gathered.materials.currentSource,
    });

    // Claim the decision before releasing the lock. The commit itself happens
    // outside it (it is slow and takes no Drive state), so without this a second
    // manager clicking approve would still see 'pending-review' and commit the
    // same edit a second time.
    await mutateDocState(workspaceId, githubPath, (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'applying',
      updatedAt: '',
    }));

    return {
      blocked: null,
      before: gathered.materials.currentSource,
      assets: delta.newAssets,
      fileId: gathered.materials.mapping.fileId,
      editor: gathered.materials.editor,
    };
  });

  if (prepared.blocked) {
    if (prepared.blocked === 'stale') {
      await buildReview(workspaceId, githubPath);
    }
    return { outcome: prepared.blocked };
  }

  // Commit only the images the approved text still points at. The manager may
  // have deleted a reference while resolving conflicts, and committing its bytes
  // anyway would put an unreferenced binary into the repository that nobody
  // chose to accept.
  const referenced = (prepared.assets ?? []).filter((asset) => params.content.includes(assetRepoPath(asset)));

  try {
    const commitSha = await commitApprovedEdit({
      workspaceId,
      githubPath,
      userId,
      before: prepared.before ?? '',
      after: params.content,
      assets: referenced,
      fileId: prepared.fileId ?? '',
      editor: prepared.editor,
    });

    // Force: the document is still in a holding state and, after the commit, the
    // content hash matches — both guards would otherwise skip the republish and
    // leave the Doc showing the pre-review text.
    const republished = await publishReplica({ workspaceId, githubPath, markdown: params.content, force: true });

    // `held-for-manual` is a preserve-mode success: the document was not written
    // because it must not be, and the publisher has already released the review
    // state and left a note asking someone to carry the remainder across by hand.
    // Treating it as a failure would set the document back to `drifted`, and the
    // next sweep would ask the manager to approve the edit they just approved.
    if (republished.outcome !== 'published' && republished.outcome !== 'held-for-manual') {
      // The commit landed, so the edit is not lost — but the replica and the
      // recorded baseline no longer describe it. Leaving the document in
      // 'applying' would freeze it; 'drifted' makes the next sweep look again.
      await mutateDocState(workspaceId, githubPath, (current) => ({
        ...(current ?? { updatedAt: '' }),
        status: 'drifted',
        error: `Committed, but the replica was not republished: ${republished.detail ?? republished.outcome}`,
        updatedAt: '',
      }));
      return { outcome: 'committed-not-republished', commitSha, detail: republished.detail ?? republished.outcome };
    }

    return { outcome: 'committed', commitSha };
  } catch (error) {
    // Release the claim so the manager can retry rather than being stuck in a
    // state no decision can leave.
    await mutateDocState(workspaceId, githubPath, (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'pending-review',
      error: (error as Error).message,
      updatedAt: '',
    }));
    Logger.error('Google Docs review approval failed', error as Error, { workspaceId, githubPath });
    return { outcome: 'failed', detail: (error as Error).message };
  }
}

async function commitApprovedEdit(params: {
  workspaceId: string;
  githubPath: string;
  userId: string;
  before: string;
  after: string;
  assets: DeltaAsset[];
  fileId: string;
  editor?: string;
}): Promise<string> {
  const repoInfo = await getGithubRepo(params.workspaceId);
  if (!repoInfo) {
    throw new Error('No GitHub repository configured for this workspace');
  }

  const record: ProvenanceRecord = {
    version: 1,
    type: 'gdocs-edit',
    file: { path: params.githubPath, name: path.posix.basename(params.githubPath) },
    createdAt: new Date().toISOString(),
    updatedBy: { userId: params.userId },
    source: { fileId: params.fileId, editor: params.editor },
    knowledge: '',
    messages: [],
    diff: { before: params.before, after: params.after },
  };
  const contextFile = await buildContextFile({
    workspaceId: params.workspaceId,
    docPath: params.githubPath,
    record,
  });

  // files[0] is the document and the rest are sidecars, matching the convention
  // the other commit paths use. Assets ride along so the images a person added
  // land in the same commit as the text that references them.
  const files = [
    { path: params.githubPath, content: params.after },
    contextFile,
    ...params.assets.map((asset) => ({
      path: path.posix.join(ASSETS_DIR, `${asset.hash}.${asset.extension}`),
      content: asset.bytes.toString('base64'),
      encoding: 'base64' as const,
    })),
  ];

  const { commitSha } = await GithubService.getInstance().commitFilesWithContext({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    branch: repoInfo.branch,
    message: `Apply Google Docs edit to ${path.posix.basename(params.githubPath)}`,
    files,
    workspaceId: params.workspaceId,
    userId: params.userId,
  });

  await persistContextToMirror(params.workspaceId, contextFile);
  return commitSha;
}

/**
 * Discards the edit and puts the replica back to the repository's content.
 *
 * Fenced on the Doc version the review was rendered against: with a poll every
 * few minutes there is always a window in which someone can have written more,
 * and restoring would destroy text no manager ever saw.
 */
export async function rejectReview(workspaceId: string, githubPath: string): Promise<DecisionResult> {
  const prepared = await replicaLock.run(docKey(workspaceId, githubPath), async () => {
    const state = await getDocState(workspaceId, githubPath);
    if (state?.status !== 'pending-review') {
      return { blocked: 'not-pending' as const };
    }

    const gathered = await gatherMaterials(workspaceId, githubPath);
    if (!gathered.ok) {
      return { blocked: gathered.status === 'not-linked' ? ('not-linked' as const) : ('not-connected' as const) };
    }
    if (state.reviewedVersion && gathered.materials.version !== state.reviewedVersion) {
      return { blocked: 'stale' as const };
    }

    await mutateDocState(workspaceId, githubPath, (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'applying',
      updatedAt: '',
    }));

    return { blocked: null, markdown: gathered.materials.currentSource };
  });

  if (prepared.blocked) {
    if (prepared.blocked === 'stale') {
      await buildReview(workspaceId, githubPath);
    }
    return { outcome: prepared.blocked };
  }

  const published = await publishReplica({
    workspaceId,
    githubPath,
    markdown: prepared.markdown ?? '',
    force: true,
  });

  // A preserved document cannot be restored by overwriting it, so rejection means
  // something weaker there: the decision is recorded and the baseline is rebuilt
  // from the document, but the text the manager turned down is still sitting in
  // Google Docs and only a person can take it back out. Reported as its own
  // outcome rather than as a restore that did not happen.
  if (published.outcome === 'held-for-manual') {
    return {
      outcome: 'declined-not-restored',
      detail: 'The document keeps the rejected text until someone reverts it',
    };
  }

  if (published.outcome !== 'published') {
    await mutateDocState(workspaceId, githubPath, (current) => ({
      ...(current ?? { updatedAt: '' }),
      status: 'pending-review',
      error: published.detail ?? published.outcome,
      updatedAt: '',
    }));
    return { outcome: 'failed', detail: published.detail ?? published.outcome };
  }

  return { outcome: 'restored' };
}
