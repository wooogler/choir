export const MANAGER_SESSION_EXPIRY = 14 * 24 * 60 * 60 * 1000; // 14 days
export const CREATE_FILE_SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/**
 * "Start Over" button — restarts the update review from the first suggestion using
 * the knowledge still held in the DOCUMENT_UPDATE session. It routes to the same
 * suggestUpdatesCallback via a dedicated action_id (to avoid colliding with the
 * suggestion's own "suggest_updates" button) and uses the initial-process-start
 * shape ({ sessionId, continueToFileSelection: true }) so the review screen is
 * skipped and we go straight to the recommended file's first suggestion.
 */
export function buildStartOverButton(sessionId: string, originalChannelId?: string, originalThreadTs?: string) {
  return {
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: '🔄 Start Over', emoji: true },
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
