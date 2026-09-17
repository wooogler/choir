/**
 * The language layer: where a person's locale comes from (resolve-locale) and
 * how a Slack request carries it (locale-middleware). The locale vocabulary
 * itself lives in `src/i18n/locales` and is re-exported here so callers have
 * one import.
 */

export { getRequestLocale, localeMiddleware } from './locale-middleware';
export {
  resolveContentLanguage,
  resolveLocaleForUser,
  resolveLocaleForUserCached,
  resolvePersonalLocaleCached,
  resolveWorkspaceLocale,
} from './resolve-locale';
export {
  DEFAULT_LOCALE,
  type Locale,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from '../../src/i18n/supported-locales';
