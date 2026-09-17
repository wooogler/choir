/**
 * Which language CHOIR speaks to a given person.
 *
 * Four sources, in descending order of how deliberately they were chosen:
 *
 *   1. the user's explicit setting in the workspace config — they said so;
 *   2. their Slack locale — they set their own Slack up that way, so it is a
 *      real signal, just not one aimed at CHOIR;
 *   3. the workspace default a manager configured;
 *   4. `DEFAULT_LOCALE`.
 *
 * A Slack locale we have no strings for (`fr-FR`) is not a vote for English: it
 * falls *through* to the workspace default, which is why `normalizeLocale`
 * returns undefined rather than `en` for an unsupported tag.
 */

import type { WebClient } from '@slack/web-api';
import { getCachedUserLocale, getUserLocale } from 'services/common/name-cache';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { type Locale, normalizeLocale } from '../../src/i18n/supported-locales';

/**
 * Full resolution, allowed one `users.info` call when the user's locale is not
 * cached. For paths that already await Slack (handlers doing real work), not
 * for middleware.
 */
export async function resolveLocaleForUser(workspaceId: string, userId: string, client: WebClient): Promise<Locale> {
  const store = new WorkspaceStore();

  const explicit = await store.getUserLanguage(workspaceId, userId);
  if (explicit) return explicit;

  const slack = normalizeLocale(await getUserLocale(userId, client));
  if (slack) return slack;

  return store.getWorkspaceLanguage(workspaceId);
}

/**
 * Only the two sources that are about *this person* — their setting and their
 * cached Slack locale — or undefined when neither answers. Callers that have a
 * better fallback than the workspace default (the web session endpoint has the
 * browser's `Accept-Language`) need to see that gap rather than be handed a
 * default they cannot tell apart from a real choice.
 */
export async function resolvePersonalLocaleCached(workspaceId: string, userId: string): Promise<Locale | undefined> {
  const explicit = await new WorkspaceStore().getUserLanguage(workspaceId, userId);
  if (explicit) return explicit;
  return normalizeLocale(getCachedUserLocale(userId));
}

/**
 * The same precedence as `resolveLocaleForUser` with no network: the Slack
 * locale is consulted only if it is already in the name cache. "Cached" is
 * about Slack, not the workspace config — the config read is a local SQLite
 * query behind an async API, so this still returns a promise.
 */
export async function resolveLocaleForUserCached(workspaceId: string, userId: string): Promise<Locale> {
  const personal = await resolvePersonalLocaleCached(workspaceId, userId);
  if (personal) return personal;

  return new WorkspaceStore().getWorkspaceLanguage(workspaceId);
}

/**
 * For messages with no single recipient — a channel post, a scheduled digest —
 * where the only defensible choice is the workspace default.
 */
export async function resolveWorkspaceLocale(workspaceId: string): Promise<Locale> {
  return new WorkspaceStore().getWorkspaceLanguage(workspaceId);
}

/** The workspace's policy for the language of generated/updated documents. */
export async function resolveContentLanguage(workspaceId: string): Promise<'follow-conversation' | Locale> {
  return new WorkspaceStore().getContentLanguage(workspaceId);
}
