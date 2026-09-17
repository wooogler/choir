/**
 * The languages CHOIR's own UI can speak, and how a raw language tag maps onto
 * them.
 *
 * Shared by the string catalogs (src/i18n), the locale resolver
 * (services/i18n) and the web session endpoint, so it must stay free of
 * imports from any of them.
 */

export const SUPPORTED_LOCALES = ['en', 'ko'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Reduces a BCP-47 tag such as Slack's `ko-KR` or a browser's `en_US` to a
 * supported locale, or `undefined` when the language is not one we have
 * strings for (callers fall through to the next source in their precedence
 * chain rather than to English here, so a workspace default can still win).
 */
export function normalizeLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return undefined;
  const language = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(language) ? language : undefined;
}
