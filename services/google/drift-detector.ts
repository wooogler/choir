import { Logger } from 'services/common/logger';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { stripBanner } from './banner';
import { exportDocMarkdown, getDocMeta } from './drive-client';
import { getDocState, mutateDocState, readBaseline } from './gdocs-state';
import { getWorkspaceClient, noteCredentialFailure } from './google-auth-service';
import { docKey, replicaLock } from './keyed-mutex';
import { publishReplica } from './replica-publisher';

/**
 * Notices when a human has edited a replica.
 *
 * Two signals, deliberately separated. Drive's `version` is only a *trigger*:
 * it advances on metadata changes too (measured — a rename alone bumps it), so
 * acting on it directly would report drift nobody caused. The *truth test* is
 * comparing a fresh markdown export against the baseline captured right after
 * the last push; those two snapshots went through the same converter, so its
 * quirks cancel and only a real edit survives.
 */

export type DriftOutcome =
  /** Version unchanged: nothing at all happened. */
  | 'unchanged'
  /** Version moved but the text did not — a rename, a permission change. */
  | 'metadata-only'
  /** Only the replica banner was removed — healed without troubling anyone. */
  | 'banner-restored'
  /** Banner removed; the caller still has to republish (see checkAndHealDocument). */
  | 'banner-removed'
  /** A human edited the document. */
  | 'drifted'
  /** A human edited a document already awaiting review. */
  | 'drifted-again'
  /** No baseline to compare against, so drift cannot be measured. */
  | 'baseline-lost'
  /** The GitHub document behind this replica is gone. */
  | 'orphaned'
  | 'trashed'
  | 'not-linked'
  | 'not-connected'
  | 'failed';

export interface DriftResult {
  githubPath: string;
  outcome: DriftOutcome;
  /**
   * True when the difference survives only as whitespace or escaping — the shape
   * a change in Google's export serializer would take across every document at
   * once, rather than a person typing.
   */
  normalizationOnly?: boolean;
  lastModifyingUser?: string;
  detail?: string;
}

/**
 * Whether two snapshots differ only in whitespace and backslash escaping. Used
 * to tell a person's edit from the export serializer changing under us.
 */
function differsOnlyInNormalization(a: string, b: string): boolean {
  const flatten = (text: string) => text.replace(/\s+/g, '').replace(/\\/g, '');
  return flatten(a) === flatten(b);
}

export async function checkDocumentForDrift(workspaceId: string, githubPath: string): Promise<DriftResult> {
  return replicaLock.run(docKey(workspaceId, githubPath), async () => {
    const store = new WorkspaceStore();

    const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
    if (!mapping) {
      return { githubPath, outcome: 'not-linked' as const };
    }

    const auth = await getWorkspaceClient(workspaceId);
    if (!auth) {
      return { githubPath, outcome: 'not-connected' as const };
    }

    const state = await getDocState(workspaceId, githubPath);

    // The source document may have been deleted or moved on GitHub. Publishing
    // is already impossible; say so rather than leaving the replica looking live.
    const source = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath);
    if (source === null) {
      if (state?.status !== 'orphaned') {
        await mutateDocState(workspaceId, githubPath, (current) => ({
          ...(current ?? { updatedAt: '' }),
          status: 'orphaned',
          error: 'The GitHub document no longer exists',
          updatedAt: '',
        }));
      }
      return { githubPath, outcome: 'orphaned' as const };
    }

    try {
      const meta = await getDocMeta(auth, mapping.fileId);

      if (meta.trashed) {
        await mutateDocState(workspaceId, githubPath, (current) => ({
          ...(current ?? { updatedAt: '' }),
          status: 'error',
          error: 'The Google Doc is in the trash',
          updatedAt: '',
        }));
        return { githubPath, outcome: 'trashed' as const };
      }

      // Already flagged and not touched since: nothing new to report.
      const alreadyFlagged = state?.status === 'drifted' || state?.status === 'pending-review';
      const reference = alreadyFlagged
        ? (state?.reviewedVersion ?? state?.lastPushedVersion)
        : state?.lastPushedVersion;
      if (meta.version && reference && meta.version === reference) {
        return { githubPath, outcome: 'unchanged' as const };
      }

      const baseline = await readBaseline(workspaceId, githubPath);
      if (baseline === null) {
        // Not "no drift": drift cannot be measured. Republishing to re-establish
        // a baseline would destroy whatever a person may have written.
        await mutateDocState(workspaceId, githubPath, (current) => ({
          ...(current ?? { updatedAt: '' }),
          status: 'baseline-lost',
          error: 'No baseline to compare against',
          updatedAt: '',
        }));
        return { githubPath, outcome: 'baseline-lost' as const };
      }

      const exported = await exportDocMarkdown(auth, mapping.fileId);
      const exportedBody = stripBanner(exported);
      const baselineBody = stripBanner(baseline);

      if (exportedBody.body === baselineBody.body) {
        // A reader deleting the banner is the most likely thing anyone touches.
        // Report it for the caller to heal — republishing here would re-enter the
        // document lock this function already holds and deadlock.
        if (baselineBody.hadBanner && !exportedBody.hadBanner) {
          return { githubPath, outcome: 'banner-removed' as const };
        }

        // Absorb the version bump so the next poll is cheap again.
        await mutateDocState(workspaceId, githubPath, (current) => ({
          ...(current ?? { updatedAt: '' }),
          status: current?.status ?? 'synced',
          lastPushedVersion: meta.version,
          updatedAt: '',
        }));
        return { githubPath, outcome: 'metadata-only' as const };
      }

      const normalizationOnly = differsOnlyInNormalization(exportedBody.body, baselineBody.body);

      await mutateDocState(workspaceId, githubPath, (current) => ({
        ...(current ?? { updatedAt: '' }),
        status: alreadyFlagged ? (current?.status ?? 'drifted') : 'drifted',
        driftDetectedAt: current?.driftDetectedAt ?? new Date().toISOString(),
        reviewedVersion: meta.version,
        lastModifyingUser: meta.lastModifyingUser,
        updatedAt: '',
      }));

      return {
        githubPath,
        outcome: alreadyFlagged ? ('drifted-again' as const) : ('drifted' as const),
        normalizationOnly,
        lastModifyingUser: meta.lastModifyingUser,
      };
    } catch (error) {
      await noteCredentialFailure(workspaceId, error);
      Logger.error(`Google Docs drift check failed for ${githubPath}`, error as Error, { workspaceId });
      return { githubPath, outcome: 'failed' as const, detail: (error as Error).message };
    }
  });
}

/**
 * Checks a document and repairs what can be repaired without a human.
 *
 * The repair runs *after* checkDocumentForDrift returns, never inside it:
 * publishing takes the same per-document lock the check holds, so calling it
 * from within would wait on a lock its own caller owns and deadlock.
 */
export async function checkAndHealDocument(workspaceId: string, githubPath: string): Promise<DriftResult> {
  const result = await checkDocumentForDrift(workspaceId, githubPath);

  if (result.outcome !== 'banner-removed') {
    return result;
  }

  const markdown = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath);
  if (markdown === null) {
    return { ...result, outcome: 'failed', detail: 'source document missing from the mirror' };
  }

  const published = await publishReplica({ workspaceId, githubPath, markdown, force: true });
  return { ...result, outcome: 'banner-restored', detail: published.outcome };
}

/**
 * How many documents must drift in one sweep, all with differences that are pure
 * normalization, before we treat it as Google having changed its markdown export
 * rather than a crowd of people editing at once. Below this, drift is drift.
 */
const MASS_DRIFT_THRESHOLD = 5;

export interface SweepResult {
  workspaceId: string;
  checked: number;
  drifted: DriftResult[];
  healed: number;
  failed: number;
  /**
   * Set when the drift looks like an export-format change rather than human
   * edits. Callers must not notify managers in that case: the fix is one
   * operator rebaselining, not every manager reviewing a whitespace diff.
   */
  massDriftSuspected: boolean;
}

export async function sweepWorkspace(workspaceId: string): Promise<SweepResult> {
  const mappings = await new WorkspaceStore().getGoogleDocMappings(workspaceId);
  const result: SweepResult = {
    workspaceId,
    checked: 0,
    drifted: [],
    healed: 0,
    failed: 0,
    massDriftSuspected: false,
  };

  for (const githubPath of Object.keys(mappings)) {
    const outcome = await checkAndHealDocument(workspaceId, githubPath);
    result.checked += 1;

    if (outcome.outcome === 'drifted' || outcome.outcome === 'drifted-again') {
      result.drifted.push(outcome);
    } else if (outcome.outcome === 'banner-restored') {
      result.healed += 1;
    } else if (outcome.outcome === 'failed' || outcome.outcome === 'trashed' || outcome.outcome === 'orphaned') {
      result.failed += 1;
    } else if (outcome.outcome === 'not-connected') {
      // Nothing in this workspace can be checked; stop rather than repeating the
      // same failed lookup once per document.
      break;
    }
  }

  result.massDriftSuspected =
    result.drifted.length >= MASS_DRIFT_THRESHOLD && result.drifted.every((entry) => entry.normalizationOnly);

  if (result.massDriftSuspected) {
    Logger.error(
      `Google Docs: ${result.drifted.length} replicas drifted at once with normalization-only differences — suspected export-format change. Manager notifications suppressed; rebaseline once verified.`,
      undefined,
      { workspaceId },
    );
  }

  return result;
}

/** Every workspace with a usable Google credential. */
export async function sweepAllWorkspaces(): Promise<SweepResult[]> {
  const configs = await new WorkspaceStore().getAllWorkspaceConfigs();
  const results: SweepResult[] = [];

  for (const config of configs) {
    if (!config.google?.auth || config.google.auth.broken) continue;
    if (!config.google.docs || Object.keys(config.google.docs).length === 0) continue;

    try {
      results.push(await sweepWorkspace(config.workspaceId));
    } catch (error) {
      Logger.error('Google Docs drift sweep failed for workspace', error as Error, {
        workspaceId: config.workspaceId,
      });
    }
  }

  return results;
}
