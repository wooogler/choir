import crypto from 'node:crypto';
import { Logger } from 'services/common/logger';
import { anonymizeText } from 'services/common/name-cache';
import { isCHOIRUser } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { isoWeekOf } from './iso-week';
import { paraphraseQuestion } from './paraphrase';
import { insertQaEvent } from './qa-event-store';

const workspaceStore = new WorkspaceStore();

export interface RecordQaEventParams {
  workspaceId: string;
  userId: string;
  question: string;
  canAnswer: boolean;
  searchResults: number;
  /** Raw Slack channel_type (im | channel | group | mpim); normalized internally. */
  channelType?: string;
  /** The retrieved documents (RetrievalDocument[]); only fileName/section metadata is stored. */
  relevantDocs?: any[];
  /** Event time (epoch ms). Defaults to now; the backfill script passes the original timestamp. */
  at?: number;
}

/** Slack's raw channel_type -> the dashboard's coarse enum. */
function normalizeChannelType(raw?: string): 'dm' | 'public' | 'private' {
  switch (raw) {
    case 'im':
      return 'dm';
    case 'group':
    case 'mpim':
      return 'private';
    default:
      // 'channel' or unknown/synthetic -> public
      return 'public';
  }
}

/**
 * Records a privacy-scrubbed Q&A event for the awareness dashboard. Safe to call
 * fire-and-forget from the answer path: it never throws (errors are logged and
 * swallowed) and does the work off the answer's critical section.
 *
 * Gating: the workspace must have the dashboard enabled (on by default), the user
 * must not have opted out, and — crucially — must be a registered CHOIR user
 * (registration is the consent point). The raw question is anonymized and
 * paraphrased before storage; if paraphrasing fails, nothing is stored.
 */
export async function recordQaEvent(params: RecordQaEventParams): Promise<void> {
  const { workspaceId, userId, question, canAnswer, searchResults, channelType, relevantDocs, at } = params;

  try {
    if (!workspaceId || !userId || !question?.trim()) return;

    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    if (!config || config.dashboardEnabled === false) return; // default on; manager can disable
    if ((config.dashboardOptOut ?? []).includes(userId)) return;
    if (!(await isCHOIRUser(workspaceId, userId))) return; // registered = consented

    // Anonymize (mask names) then paraphrase (strip remaining specifics). The raw
    // question text is never stored.
    const anonymized = anonymizeText(question, workspaceId);
    const paraphrase = await paraphraseQuestion(anonymized, workspaceId);
    if (!paraphrase) return; // paraphrase failed → skip; never fall back to raw text

    const salt = await workspaceStore.getOrCreateDashboardSalt(workspaceId);
    const userHash = crypto.createHmac('sha256', salt).update(userId).digest('hex');

    const now = at ?? Date.now();
    const chunks = (relevantDocs ?? [])
      .map((doc) => doc?.metadata)
      .filter((meta) => meta?.fileName)
      .map((meta) => ({
        fileName: meta.fileName as string,
        sectionId: meta.sectionId as string | undefined,
        headingPath: meta.headingPath as string | undefined,
      }));

    insertQaEvent({
      workspaceId,
      createdAt: now,
      isoWeek: isoWeekOf(now),
      channelType: normalizeChannelType(channelType),
      canAnswer,
      searchResults,
      userHash,
      paraphrase,
      chunks,
    });
  } catch (error) {
    Logger.warn('Dashboard QA recorder failed', { workspaceId, error: error instanceof Error ? error.message : error });
  }
}
