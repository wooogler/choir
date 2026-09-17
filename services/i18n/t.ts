import type { WebClient } from '@slack/web-api';
import { type T, createT } from '../../src/i18n';
import { getRequestLocale } from './locale-middleware';
import { resolveLocaleForUser, resolveLocaleForUserCached, resolveWorkspaceLocale } from './resolve-locale';

/**
 * The translator for the person who triggered the current Bolt request. Reads
 * the locale the middleware stamped on `context`, so it costs nothing.
 */
export function tForRequest(context: unknown): T {
  return createT(getRequestLocale(context));
}

/**
 * The translator for a message *sent to* `userId`, who is usually not the
 * person acting: a manager receiving a review card, a requester being told
 * their access was approved. Pass `client` when the recipient may never have
 * been looked up before (their first interaction), so their Slack locale can
 * be fetched; omit it on hot paths to stay off the network.
 */
export async function tForUser(workspaceId: string, userId: string, client?: WebClient): Promise<T> {
  const locale = client
    ? await resolveLocaleForUser(workspaceId, userId, client)
    : await resolveLocaleForUserCached(workspaceId, userId);
  return createT(locale);
}

/**
 * The translator for a post with no single reader — a channel message — which
 * follows the workspace default rather than any one person's preference.
 */
export async function tForWorkspace(workspaceId: string): Promise<T> {
  return createT(await resolveWorkspaceLocale(workspaceId));
}
