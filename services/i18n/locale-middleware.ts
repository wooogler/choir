/**
 * Puts the requester's language on Bolt's `context` so every handler can reach
 * it without repeating the resolution — or, worse, each deciding differently.
 *
 * Two rules keep it safe on the hot path. It never makes a Slack call: the
 * cached resolver is used, so a user whose locale has not been fetched yet gets
 * the workspace default for this one request and the right language as soon as
 * any name lookup warms the cache. And it never throws: a language is a
 * presentation detail, so a failure here degrades to `DEFAULT_LOCALE` rather
 * than dropping the user's request.
 */

import { extractUserIdFromPayload } from 'services/slack/usage-monitor';
import { DEFAULT_LOCALE, type Locale, isSupportedLocale } from '../../src/i18n/supported-locales';
import { resolveLocaleForUserCached } from './resolve-locale';

/** Bolt sets `context.teamId` for most requests; the body is the fallback. */
function extractWorkspaceId(context: any, body: any): string | undefined {
  return (
    context?.teamId ||
    body?.team_id ||
    body?.team?.id ||
    body?.view?.team_id ||
    body?.event?.team ||
    body?.authorizations?.[0]?.team_id ||
    undefined
  );
}

export const localeMiddleware = async ({ context, body, event, next }: any) => {
  let locale: Locale = DEFAULT_LOCALE;
  try {
    const workspaceId = extractWorkspaceId(context, body);
    const userId = extractUserIdFromPayload(body, event);
    if (workspaceId && userId) {
      locale = await resolveLocaleForUserCached(workspaceId, userId);
    }
  } catch {
    // A missing config, an unreadable DB, an unexpected payload shape: none of
    // them are reasons to drop the request. English is a worse answer than the
    // right language, but a far better one than no answer.
  }
  if (context) context.locale = locale;
  await next();
};

/**
 * Reads the locale the middleware stored. Handlers call this instead of typing
 * against Bolt's context generics, which would mean threading a custom context
 * type through every listener registration.
 */
export function getRequestLocale(context: unknown): Locale {
  const locale = (context as { locale?: unknown } | null | undefined)?.locale;
  return isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
}
