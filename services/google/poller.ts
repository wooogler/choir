import { AppConfig } from '@/config';
import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { sweepAllWorkspaces } from './drift-detector';
import { notifyDrift } from './drift-notifier';
import { documentsAwaitingNotice, notifyManualApply } from './manual-apply';

/**
 * Periodically asks Drive whether anyone has edited a replica.
 *
 * Polling rather than push: `files.watch` channels expire after a day and need a
 * public HTTPS endpoint, which buys nothing at a few minutes' latency. A
 * `files.get` costs 5 quota units, so even hundreds of documents are far inside
 * the per-minute allowance.
 */

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;

let running = false;

/**
 * One sweep across every connected workspace. Guarded against overlap: a slow
 * sweep must not have the next tick start on top of it, doubling the API calls
 * and racing on the same state files.
 */
export async function runDriftSweep(client: WebClient): Promise<void> {
  if (running) {
    Logger.info('Google Docs drift sweep skipped: the previous run is still going');
    return;
  }
  running = true;

  try {
    for (const sweep of await sweepAllWorkspaces()) {
      // A change CHOIR could not push into a document that keeps its own
      // formatting. This runs here rather than at the publish hooks because
      // those have no Slack client in scope — schedulePublish is fire-and-forget
      // from a service with no way to reach Slack — so the poller is where a
      // held change gets turned into something a person sees. Independent of
      // drift, and so not subject to the mass-drift suppression below.
      for (const githubPath of await documentsAwaitingNotice(sweep.workspaceId)) {
        try {
          await notifyManualApply({ workspaceId: sweep.workspaceId, githubPath, client });
        } catch (error) {
          Logger.error('Google Docs manual-apply notification failed', error as Error, {
            workspaceId: sweep.workspaceId,
            githubPath,
          });
        }
      }

      if (sweep.drifted.length === 0) continue;

      // Suspected export-format change: one operator rebaselines, rather than
      // every manager reviewing a whitespace diff.
      if (sweep.massDriftSuspected) continue;

      for (const result of sweep.drifted) {
        try {
          await notifyDrift({ workspaceId: sweep.workspaceId, result, client });
        } catch (error) {
          Logger.error('Google Docs drift notification failed', error as Error, {
            workspaceId: sweep.workspaceId,
            githubPath: result.githubPath,
          });
        }
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Starts the poller, or does nothing when Google sync is not configured. Returns
 * the timer so callers can stop it; unref'd so it never holds the process open.
 */
export function startDriftPoller(client: WebClient): NodeJS.Timeout | null {
  if (!AppConfig.getGoogleConfig().configured) {
    return null;
  }

  const intervalMs = Number(process.env.GOOGLE_DRIFT_POLL_MS || DEFAULT_INTERVAL_MS);
  const timer = setInterval(() => {
    void runDriftSweep(client).catch((error) => {
      Logger.error('Google Docs drift sweep failed', error as Error);
    });
  }, intervalMs);
  timer.unref();

  Logger.info(`Google Docs drift poller started (every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}
