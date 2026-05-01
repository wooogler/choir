export const MANAGER_SESSION_EXPIRY = 14 * 24 * 60 * 60 * 1000; // 14 days
export const CREATE_FILE_SESSION_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

export function createMessageLink(workspaceUrl: string, channelId: string, messageTs?: string): string {
  const baseUrl = workspaceUrl.replace(/\/$/, '');
  if (messageTs) {
    const encodedTs = messageTs.replace('.', '');
    return `${baseUrl}/archives/${channelId}/p${encodedTs}`;
  }
  return `${baseUrl}/archives/${channelId}`;
}
