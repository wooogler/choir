import { detectDocumentLanguage } from 'services/common/language';
import { Logger } from 'services/common/logger';
import { resolveContentLanguage } from 'services/i18n/resolve-locale';
import { type GoogleDocMapping, WorkspaceStore } from 'services/workspace/workspace-store';
import type { Locale } from '../../src/i18n/supported-locales';
import { stripBanner, withBanner } from './banner';
import { exportDocMarkdown, getDocMeta, replaceDocContent, setDocDescription } from './drive-client';
import { extractImportable, sameAfterDialect } from './gdocs-delta';
import { contentHash, getDocState, mutateDocState, writeBaseline, writeSourceSnapshot } from './gdocs-state';
import { getWorkspaceClient, noteCredentialFailure } from './google-auth-service';
import { rewriteImagesForDrive } from './image-rewrite';
import { docKey, replicaLock } from './keyed-mutex';
import type { GdocsDocStatus } from './types';

/**
 * Publishes GitHub documents into their Google Docs replicas.
 *
 * A `replica` is a derivative, so "replace the whole thing" is the correct
 * semantics and there is no index-mapping layer to maintain. What needs care is
 * not overwriting a human: every state except `synced` means someone's edit is
 * sitting in Google Docs awaiting review, and publishing over it would destroy
 * work nobody has seen.
 *
 * A `preserve` document is the opposite case — one that was a document before
 * CHOIR saw it — and none of that applies: its body is never written at all, so
 * the destructive primitive below must stay unreachable for it. Its bookkeeping
 * is established by `seedReplica`, which records the same baseline/snapshot pair
 * the rest of the machinery reads without touching the document to get it.
 */

export type PublishOutcome =
  | 'published'
  /** Content is byte-identical to what was last pushed. */
  | 'unchanged'
  /** A human's edit is pending review; publishing would overwrite it. */
  | 'held'
  /**
   * The document is in `preserve` mode, so nothing was written. The change is
   * recorded against the document and a person applies it in Google Docs. Not a
   * failure: the commit it came from is safe on GitHub either way.
   */
  | 'held-for-manual'
  /**
   * The mapping predates `GoogleDocMapping.mode` and no mode can be safely
   * assumed. Run `pnpm backfill:gdocs-mode`.
   */
  | 'unknown-mode'
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

export type SeedOutcome =
  /** Bookkeeping recorded; the Doc still matches what we read. */
  | 'seeded'
  /**
   * Bookkeeping recorded, but the Doc moved while we were reading it. The
   * baseline is still correct — it is the export the repository content was
   * derived from — so the difference is a real human edit and is left for the
   * poller to report.
   */
  | 'seeded-drifted'
  | 'not-linked'
  | 'not-connected'
  | 'failed';

export interface SeedResult {
  outcome: SeedOutcome;
  detail?: string;
}

export interface SeedParams {
  workspaceId: string;
  githubPath: string;
  /** Repository markdown that was derived from `baseline`. */
  markdown: string;
  /** The export `markdown` was derived from. Becomes the stored baseline. */
  baseline: string;
  /**
   * Written to the file's Drive `description`, replacing the body banner a
   * replica would carry. Best effort: a failure here is cosmetic and must not
   * abort the seed.
   */
  description?: string;
}

/**
 * Establishes a document's sync bookkeeping without writing a single byte to it.
 *
 * The publisher normally earns its baseline by writing: it replaces the body,
 * exports what it just wrote, and stores that. A document whose formatting must
 * survive cannot be written, so the baseline has to come from a read instead —
 * which is sound as long as the *pair* is honest. `baseline` must be the export
 * that `markdown` was extracted from, because everything downstream
 * (`alignBaselineToSource`, and through it the whole delta path) reads the two
 * as two halves of one moment.
 *
 * The document is re-exported afterwards only to find out whether anybody typed
 * in the meantime. If they did, the stored baseline is still the right one and
 * the difference is exactly their edit, so the document is left `drifted` for
 * the ordinary review path rather than being quietly adopted.
 */
/**
 * The language of the notice CHOIR writes into (or about) someone's Google Doc.
 *
 * It follows the workspace's content-language policy, because the banner is
 * content: it sits in the document body a reader opens, not in CHOIR's own UI.
 * Under `follow-conversation` there is no configured answer, so the document
 * speaks for itself and the banner matches the markdown being published.
 * `detectDocumentLanguage` can return a language CHOIR has no banner for, which
 * falls back to English the same way an unset policy does.
 */
export async function bannerLanguage(workspaceId: string, markdown: string): Promise<Locale> {
  let policy: 'follow-conversation' | Locale;
  try {
    policy = await resolveContentLanguage(workspaceId);
  } catch {
    policy = 'follow-conversation';
  }

  if (policy !== 'follow-conversation') return policy;
  return detectDocumentLanguage(markdown) === 'ko' ? 'ko' : 'en';
}

export async function seedReplica(params: SeedParams): Promise<SeedResult> {
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

    try {
      // Stamped before the version is read, so its bump is absorbed here rather
      // than surfacing as a phantom change on the next poll.
      if (params.description) {
        try {
          await setDocDescription(auth, mapping.fileId, params.description);
        } catch (error) {
          Logger.warn('Could not stamp the Google Doc description', {
            workspaceId,
            githubPath,
            error: (error as Error).message,
          });
        }
      }

      const current = await exportDocMarkdown(auth, mapping.fileId);
      const meta = await getDocMeta(auth, mapping.fileId);

      // Both halves of the same moment, exactly as the publish path records them.
      await writeBaseline(workspaceId, githubPath, params.baseline);
      await writeSourceSnapshot(workspaceId, githubPath, params.markdown);

      const settled = stripBanner(current).body === stripBanner(params.baseline).body;
      const hash = contentHash(params.markdown);

      await mutateDocState(workspaceId, githubPath, (state) => ({
        ...(state ?? { updatedAt: '' }),
        status: settled ? 'synced' : 'drifted',
        // Recorded either way: this content genuinely is what the document held
        // when it was read, so a publish of the same markdown would be a no-op.
        lastPushedContentHash: hash,
        lastPushedAt: new Date().toISOString(),
        lastPushedVersion: settled ? meta.version : state?.lastPushedVersion,
        latestVersion: settled ? undefined : meta.version,
        driftDetectedAt: settled ? undefined : (state?.driftDetectedAt ?? new Date().toISOString()),
        lastModifyingUser: settled ? state?.lastModifyingUser : meta.lastModifyingUser,
        error: undefined,
        updatedAt: '',
      }));

      return { outcome: settled ? ('seeded' as const) : ('seeded-drifted' as const) };
    } catch (error) {
      const rejected = await noteCredentialFailure(workspaceId, error);
      const detail = (error as Error).message;
      Logger.error(`Google Docs seed failed for ${githubPath}`, error as Error, { workspaceId });
      return { outcome: 'failed' as const, detail: rejected ? `credential rejected: ${detail}` : detail };
    }
  });
}

/**
 * What happens to a GitHub-side change aimed at a document CHOIR must not write.
 *
 * Runs inside the caller's document lock, so it takes no lock of its own; the
 * `mutateDocState` calls below are keyed per workspace rather than per document
 * and so do not re-enter it.
 *
 * Two very different situations arrive here:
 *
 *  - An ordinary publish hook (`force` unset). The document cannot receive the
 *    change, so it is recorded and a person is asked to apply it. Nothing about
 *    the document's own state moves: it is still whatever it was.
 *  - The tail of a decision (`force` set, from approve and reject). Something has
 *    just been settled and the document's body is authoritative for itself, so
 *    the baseline pair is rebuilt from a fresh read. Without this the document
 *    would stay `drifted` after every approval and the manager would be asked to
 *    approve the same edit forever.
 */
async function holdForManualApply(params: PublishParams, mapping: GoogleDocMapping): Promise<PublishResult> {
  const { workspaceId, githubPath } = params;
  const hash = contentHash(params.markdown);
  const state = await getDocState(workspaceId, githubPath);

  if (!params.force) {
    // Someone's edit is already waiting on a manager. Their decision republishes,
    // and this change is reconsidered then.
    if (state && HOLDING_STATES.has(state.status)) {
      return { outcome: 'held' as const, detail: state.status };
    }
    // The document already holds this text — nothing for anyone to apply. If a
    // request for exactly this content was outstanding, somebody has since
    // applied it, so retire it rather than leaving the document looking stuck.
    if (state?.lastPushedContentHash === hash) {
      if (state.pendingManual) {
        await mutateDocState(workspaceId, githubPath, (existing) =>
          existing ? { ...existing, pendingManual: undefined, updatedAt: '' } : null,
        );
      }
      return { outcome: 'unchanged' as const };
    }
    return recordPendingManual(workspaceId, githubPath, hash);
  }

  const auth = await getWorkspaceClient(workspaceId);
  if (!auth) {
    return { outcome: 'not-connected' as const };
  }

  try {
    const current = await exportDocMarkdown(auth, mapping.fileId);
    const meta = await getDocMeta(auth, mapping.fileId);
    // What the repository would hold if this document were imported right now.
    const asRepository = extractImportable(stripBanner(current).body).markdown;

    // The decision was fenced on `reviewedVersion` while the lock was held, but
    // the commit runs outside it and this read comes after. If the document has
    // moved since the manager saw it, somebody typed in that window: adopting
    // this export as the baseline would swallow their paragraph, leaving it in
    // the document but invisible to review forever. Record it as drift instead
    // and let the ordinary path put it in front of a person.
    const movedSinceReview = Boolean(state?.reviewedVersion && meta.version && meta.version !== state.reviewedVersion);

    await writeBaseline(workspaceId, githubPath, current);
    await writeSourceSnapshot(workspaceId, githubPath, asRepository);
    await mutateDocState(workspaceId, githubPath, (existing) => ({
      ...(existing ?? { updatedAt: '' }),
      status: movedSinceReview ? 'drifted' : 'synced',
      lastPushedVersion: meta.version,
      // The invariant this field carries in preserve mode: "the repository
      // markdown equivalent to what the document currently holds".
      lastPushedContentHash: contentHash(asRepository),
      lastPushedAt: new Date().toISOString(),
      driftDetectedAt: movedSinceReview ? new Date().toISOString() : undefined,
      latestVersion: movedSinceReview ? meta.version : undefined,
      reviewedVersion: undefined,
      oursBlobSha: undefined,
      reviewCards: undefined,
      error: undefined,
      // Cleared here and re-set below if it is still true. A request that has
      // since been carried out must not keep flagging the document as waiting.
      pendingManual: undefined,
      updatedAt: '',
    }));

    // Whatever the decision did not put into the document — a manager's edits in
    // the review screen, or GitHub-side commits held back while it was drifted —
    // is still outstanding and someone has to apply it by hand.
    if (!sameAfterDialect(asRepository, params.markdown)) {
      return recordPendingManual(workspaceId, githubPath, hash);
    }

    return { outcome: 'published' as const, detail: 'preserve:reseeded' };
  } catch (error) {
    const rejected = await noteCredentialFailure(workspaceId, error);
    const detail = (error as Error).message;
    Logger.error(`Google Docs preserve-mode reseed failed for ${githubPath}`, error as Error, { workspaceId });
    return { outcome: 'failed' as const, detail: rejected ? `credential rejected: ${detail}` : detail };
  }
}

/** Notes that a GitHub change is waiting for a person to apply it in Google Docs. */
async function recordPendingManual(
  workspaceId: string,
  githubPath: string,
  targetHash: string,
): Promise<PublishResult> {
  await mutateDocState(workspaceId, githubPath, (existing) => ({
    ...(existing ?? { status: 'synced', updatedAt: '' }),
    status: existing?.status ?? 'synced',
    // Deliberately not a status: a newer GitHub change should replace this one
    // rather than being held behind it, which a holding state would do.
    pendingManual: { targetHash, requestedAt: new Date().toISOString() },
    updatedAt: '',
  }));

  Logger.info('Google Docs change held for manual application', { workspaceId, githubPath });
  return { outcome: 'held-for-manual' as const };
}

export async function publishReplica(params: PublishParams): Promise<PublishResult> {
  const { workspaceId, githubPath } = params;

  return replicaLock.run(docKey(workspaceId, githubPath), async () => {
    const store = new WorkspaceStore();

    const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
    if (!mapping) {
      return { outcome: 'not-linked' as const };
    }

    // Refused rather than defaulted. Assuming `replica` would replace the body of
    // a document somebody wrote, which is the failure this whole mode exists to
    // prevent; assuming `preserve` would silently stop syncing a real replica.
    // `pnpm backfill:gdocs-mode` stamps the mappings that predate the field.
    if (!mapping.mode) {
      Logger.error(`Google Doc mapping for ${githubPath} has no mode; run pnpm backfill:gdocs-mode`, undefined, {
        workspaceId,
      });
      await mutateDocState(workspaceId, githubPath, (current) => ({
        ...(current ?? { status: 'error', updatedAt: '' }),
        status: current?.status ?? 'error',
        error: 'This document is linked without a sync mode. Run the gdocs-mode backfill.',
        updatedAt: '',
      }));
      return { outcome: 'unknown-mode' as const };
    }

    // The one guard that matters: below this line lives `replaceDocContent`, and
    // a preserved document must never reach it — not even with `force`, which
    // exists to bypass the *content* guards, not this one.
    if (mapping.mode === 'preserve') {
      return holdForManualApply(params, mapping);
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

    const body = withBanner(
      rewriteImagesForDrive(workspaceId, githubPath, params.markdown),
      await bannerLanguage(workspaceId, params.markdown),
    );

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
    // A preserved document counts as held: the change did not reach it, and a
    // sweep that reported it as published would be claiming work it did not do.
    else if (outcome.outcome === 'held' || outcome.outcome === 'held-for-manual') result.held.push(file.path);
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
