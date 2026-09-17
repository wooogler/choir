import type { WebClient } from '@slack/web-api';
import { tForUser } from 'services/i18n';
import { type T, createT, isSupportedLocale } from '../../../../src/i18n';

export const MANAGER_SESSION_EXPIRY = 14 * 24 * 60 * 60 * 1000; // 14 days
export const CREATE_FILE_SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The translator for whoever is driving this review.
 *
 * `tForRequest(context)` is the normal answer, but it is not enough on its own
 * here: half the entry points into the review re-enter the handler with a
 * synthesised Bolt payload — the skip timer, the two Q&A "start update" actions,
 * keep-flow's call into the apply handler — and none of them carry a `context`,
 * so the middleware's locale is missing exactly when a real person is waiting
 * for the message. When it is missing, fall back to the recipient's own locale:
 * everything this flow sends lands in `userId`'s DM.
 */
export async function tForReviewer(
  context: unknown,
  workspaceId: string,
  userId: string,
  client?: WebClient,
): Promise<T> {
  const locale = (context as { locale?: unknown } | null | undefined)?.locale;
  return isSupportedLocale(locale) ? createT(locale) : tForUser(workspaceId, userId, client);
}

/**
 * "Start Over" button — restarts the update review from the first suggestion using
 * the knowledge still held in the DOCUMENT_UPDATE session. It routes to the same
 * suggestUpdatesCallback via a dedicated action_id (to avoid colliding with the
 * suggestion's own "suggest_updates" button) and uses the initial-process-start
 * shape ({ sessionId, continueToFileSelection: true }) so the review screen is
 * skipped and we go straight to the recommended file's first suggestion.
 *
 * `t` is optional so the modal-close handler, which has no translator in hand,
 * still gets the English label it has always rendered.
 */
export function buildStartOverButton(sessionId: string, originalChannelId?: string, originalThreadTs?: string, t?: T) {
  const label = t ? t('docUpdate.suggestions.button.startOver') : '🔄 Start Over';
  return {
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: label, emoji: true },
    action_id: 'restart_update_review',
    value: JSON.stringify({ sessionId, continueToFileSelection: true, originalChannelId, originalThreadTs }),
  };
}

export function createMessageLink(workspaceUrl: string, channelId: string, messageTs?: string): string {
  const baseUrl = workspaceUrl.replace(/\/$/, '');
  if (messageTs) {
    const encodedTs = messageTs.replace('.', '');
    return `${baseUrl}/archives/${channelId}/p${encodedTs}`;
  }
  return `${baseUrl}/archives/${channelId}`;
}
