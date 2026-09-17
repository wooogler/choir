/**
 * The languages the viewer can speak — re-exported from the server module so
 * the list cannot drift.
 *
 * `src/i18n/supported-locales.ts` is import-free by design, which is what makes
 * it safe to pull across the workspace boundary: Vite bundles the one file, and
 * nothing of the node app comes with it. The indirection exists so that every
 * file under `web/src` imports `./supported-locales` and this module is the
 * only place that knows where the original lives.
 */

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from '../../../src/i18n/supported-locales';
export type { Locale } from '../../../src/i18n/supported-locales';
