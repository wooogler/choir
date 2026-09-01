import { Logger } from 'services/common/logger';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { withBanner } from './banner';
import { exportDocMarkdown, getDocMeta, replaceDocContent } from './drive-client';
import { contentHash, getDocState, mutateDocState, writeBaseline, writeSourceSnapshot } from './gdocs-state';
import { getWorkspaceClient, noteCredentialFailure } from './google-auth-service';
import { rewriteImagesForDrive } from './image-rewrite';
import { docKey, replicaLock } from './keyed-mutex';
import type { GdocsDocStatus } from './types';

/**
 * Publishes GitHub documents into their Google Docs replicas.
 *
 * A replica is a derivative, so "replace the whole thing" is the correct
 * semantics and there is no index-mapping layer to maintain. What needs care is
 * not overwriting a human: every state except `synced` means someone's edit is
 * sitting in Google Docs awaiting review, and publishing over it would destroy
 * work nobody has seen.
 */

export type PublishOutcome =
  | 'published'
  /** Content is byte-identical to what was last pushed. */
  | 'unchanged'
  /** A human's edit is pending review; publishing would overwrite it. */
  | 'held'
  | 'not-linked'
  /** No Google account connected, or its credential was rejected. */
  | 'not-connected'
  | 'failed';

export interface PublishResult {
  outcome: PublishOutcome;
  detail?: string;
}

/** States in which a GitHub change must not be pushed over the Doc. */
const HOLDING_STATES: ReadonlySet<GdocsDocStatus> = new Set<GdocsDocStatus>([
  'drifted',
  'pending-review',
  'applying',
  'baseline-lost',
  'orphaned',
]);

export interface PublishParams {
  workspaceId: string;
  githubPath: string;
  markdown: string;
  /**
   * Bypasses both the unchanged-content and holding-state guards.
   *
   * Required for the approve and reject paths: after a rejection the GitHub
   * content has not changed, so the hash guard would skip the restore and leave
   * the rejected edits sitting in the Doc; and both paths run while the document
   * is still in a holding state.
   */
  force?: boolean;
}

export async function publishReplica(params: PublishParams): Promise<PublishResult> {
  const { workspaceId, githubPath } = params;

  return replicaLock.run(docKey(workspaceId, githubPath), async () => {
    const store = new WorkspaceStore();

    const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
    if (!mapping) {
      return { outcome: 'not-linked' as const };
    }

    const auth = await getWorkspaceClient(workspaceId);
    if (!auth) {
      return { outcome: 'not-connected' as const };
    }

    const state = await getDocState(workspaceId, githubPath);
    const hash = contentHash(params.markdown);

    if (!params.force) {
      if (state && HOLDING_STATES.has(state.status)) {
        return { outcome: 'held' as const, detail: state.status };
      }
      if (state?.lastPushedContentHash === hash) {
        return { outcome: 'unchanged' as const };
      }
    }

    const body = withBanner(rewriteImagesForDrive(workspaceId, githubPath, params.markdown));

    try {
      const fenced = await pushWithVersionFence(auth, mapping.fileId, body);

      if (!fenced.fenced) {
        // Someone edited the Doc while we were writing it. The export we took
        // would bake their change into the baseline, after which the poller would
        // compare their edit against itself and never report drift. Record no
        // baseline and let the poller pick the edit up.
        await mutateDocState(workspaceId, githubPath, (current) => ({
          ...(current ?? { updatedAt: '' }),
          status: 'drifted',
          driftDetectedAt: new Date().toISOString(),
          lastPushedContentHash: hash,
          updatedAt: '',
        }));
        Logger.warn('Google Docs replica changed mid-publish; treating as drift', { workspaceId, githubPath });
        return { outcome: 'published' as const, detail: 'raced-into-drift' };
      }

      // Both halves of the same moment: the export, and the repository markdown
      // that produced it. Delta extraction needs the pair to bridge the two
      // markdown dialects (see readSourceSnapshot).
      await writeBaseline(workspaceId, githubPath, fenced.baseline);
      await writeSourceSnapshot(workspaceId, githubPath, params.markdown);
      await mutateDocState(workspaceId, githubPath, (current) => ({
        ...(current ?? { updatedAt: '' }),
        status: 'synced',
        lastPushedVersion: fenced.version,
        lastPushedContentHash: hash,
        lastPushedAt: new Date().toISOString(),
        driftDetectedAt: undefined,
        reviewedVersion: undefined,
        oursBlobSha: undefined,
        reviewCards: undefined,
        error: undefined,
        updatedAt: '',
      }));

      return { outcome: 'published' as const };
    } catch (error) {
      const rejected = await noteCredentialFailure(workspaceId, error);
      const detail = (error as Error).message;

      await mutateDocState(workspaceId, githubPath, (current) => ({
        ...(current ?? { status: 'error', updatedAt: '' }),
        status: current?.status ?? 'error',
        error: detail,
        updatedAt: '',
      }));

      Logger.error(`Google Docs replica publish failed for ${githubPath}`, error as Error, { workspaceId });
      return { outcome: 'failed' as const, detail: rejected ? `credential rejected: ${detail}` : detail };
    }
  });
}

interface FencedPush {
  version?: string;
  baseline: string;
  /**
   * False when the document moved between the write and the readback, meaning
   * the exported text is not what we wrote and must not become the baseline.
   */
  fenced: boolean;
}

/**
 * Writes the document, then reads back the export and the version, and confirms
 * nothing changed in between.
 *
 * The version is observed twice: once on the update response and once after the
 * export. When they agree, nothing happened in the window and the export is a
 * faithful baseline.
 *
 * When they disagree, that is a trigger and not proof. Drive bumps `version`
 * for metadata as readily as for content — a rename alone does it, measured in
 * the P0 spike — and in practice a freshly linked document disagrees routinely:
 * the write settles in more than one bump, or somebody simply has the Doc open.
 * Treating that as a human edit left every new replica `drifted` with no
 * baseline at all, holding back the very first push.
 *
 * So a disagreement is settled on content instead: take the export again, and
 * if the two are byte-identical then nothing was written between them and the
 * first one still describes the document. Only genuinely differing bytes mean
 * somebody wrote inside the window.
 */
async function pushWithVersionFence(
  auth: Awaited<ReturnType<typeof getWorkspaceClient>> & object,
  fileId: string,
  body: string,
): Promise<FencedPush> {
  const written = await replaceDocContent(auth, fileId, body);
  const baseline = await exportDocMarkdown(auth, fileId);
  const after = await getDocMeta(auth, fileId);

  if (Boolean(written.version) && written.version === after.version) {
    return { version: after.version, baseline, fenced: true };
  }

  const confirmation = await exportDocMarkdown(auth, fileId);
  const settled = await getDocMeta(auth, fileId);

  if (confirmation === baseline) {
    // The newest version we have seen, so the poller does not read the same
    // bump we just forgave as a fresh change.
    return { version: settled.version, baseline, fenced: true };
  }

  return { version: settled.version, baseline: confirmation, fenced: false };
}

export interface PublishManyResult {
  published: string[];
  held: string[];
  failed: string[];
}

/**
 * Publishes whichever of `files` are linked to a replica. Called from the sync
 * hooks, which hand over the workspace's whole file set rather than a delta, so
 * unmapped paths and unchanged content are filtered here.
 */
export async function publishLinkedReplicas(
  workspaceId: string,
  files: Array<{ path: string; content: string }>,
): Promise<PublishManyResult> {
  const store = new WorkspaceStore();
  const mappings = await store.getGoogleDocMappings(workspaceId);
  const result: PublishManyResult = { published: [], held: [], failed: [] };

  if (Object.keys(mappings).length === 0) {
    return result;
  }

  for (const file of files) {
    if (!mappings[file.path]) continue;

    const outcome = await publishReplica({
      workspaceId,
      githubPath: file.path,
      markdown: file.content,
    });

    if (outcome.outcome === 'published') result.published.push(file.path);
    else if (outcome.outcome === 'held') result.held.push(file.path);
    else if (outcome.outcome === 'failed') result.failed.push(file.path);

    // A rejected credential kills every remaining document too; stop early
    // rather than burning the rate limit on calls that cannot succeed.
    if (outcome.outcome === 'not-connected') break;
  }

  if (result.published.length || result.held.length || result.failed.length) {
    Logger.info('Google Docs replicas published', {
      workspaceId,
      published: result.published.length,
      held: result.held.length,
      failed: result.failed.length,
    });
  }

  return result;
}

/**
 * Publishes in the background. Replica publishing is a side effect of a
 * successful GitHub write: it must never delay or fail the commit that triggered
 * it, so failures are logged and dropped. Nothing is lost — the next trigger
 * republishes, because a failed publish records no content hash.
 */
export function schedulePublish(params: PublishParams & { reason: string }): void {
  void publishReplica(params).catch((error) => {
    Logger.warn('Google Docs replica publish failed', {
      workspaceId: params.workspaceId,
      githubPath: params.githubPath,
      reason: params.reason,
      error: (error as Error).message,
    });
  });
}

export function schedulePublishAll(
  workspaceId: string,
  files: Array<{ path: string; content: string }>,
  reason: string,
): void {
  void publishLinkedReplicas(workspaceId, files).catch((error) => {
    Logger.warn('Google Docs replica publish sweep failed', {
      workspaceId,
      reason,
      error: (error as Error).message,
    });
  });
}
