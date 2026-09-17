/**
 * The translation lookup: `t('common.button.cancel')`.
 *
 * This is deliberately ~40 lines rather than i18next. What CHOIR actually
 * needs from a library is compile-time key safety (`pnpm verify` catches a
 * typo or a key deleted from English) and Block Kit length enforcement, and
 * neither comes out of a runtime catalog loaded from JSON. Plurals are the one
 * hard part and `Intl.PluralRules` already solves them.
 *
 * `./supported-locales` is the locale *list*; `./locales/en` and `./locales/ko`
 * are the catalogs.
 */

import { en } from './locales/en';
import { ko } from './locales/ko';
import { isPluralForms, selectPluralForm } from './plural';
import type { Locale } from './supported-locales';
import type { LocaleCatalog, MessageKey, MessageValue, Params, TranslateArgs } from './types';

export { SLACK_LIMITS, type SlackLengthKind, assertWithinSlackLimit, kindOfKey } from './limits';
export { isPluralForms, selectPluralForm } from './plural';
export type {
  Catalog,
  LocaleCatalog,
  MessageKey,
  MessageValue,
  ParamValue,
  Params,
  PluralForms,
  PluralParams,
  TranslateArgs,
} from './types';
export {
  DEFAULT_LOCALE,
  type Locale,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from './supported-locales';
export { en } from './locales/en';
export { ko } from './locales/ko';

/** Every catalog by locale, for the build-time checks and for `t`'s lookup. */
export const catalogs: Readonly<Record<Locale, LocaleCatalog>> = { en, ko };

/**
 * `{name}` rather than `${name}` so catalog entries stay inert data: a template
 * literal would be evaluated by whoever wrote the file, which defeats the point
 * of shipping strings translators can edit.
 */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Unknown placeholders are left verbatim. A half-filled sentence is a visible
 * bug report; an empty hole silently reads as a finished sentence.
 */
function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** English backs every locale, key by key, so a partial catalog is shippable. */
function lookup(locale: Locale, key: MessageKey): MessageValue {
  return catalogs[locale][key] ?? en[key];
}

function render(locale: Locale, key: MessageKey, params?: Params): string {
  const entry = lookup(locale, key);
  if (isPluralForms(entry)) {
    const count = typeof params?.count === 'number' ? params.count : Number(params?.count ?? 0);
    return interpolate(selectPluralForm(locale, entry, count), params);
  }
  return interpolate(entry, params);
}

/** A bound translator, carrying the locale it was built for. */
export interface T {
  <K extends MessageKey>(key: K, ...args: TranslateArgs<K>): string;
  readonly locale: Locale;
}

/**
 * Binds a locale once at the top of a handler so call sites read as `t(key)`
 * and cannot accidentally mix locales inside one Slack response.
 */
export function createT(locale: Locale): T {
  const translator = (key: MessageKey, params?: Params): string => render(locale, key, params);
  return Object.assign(translator, { locale });
}

/** One-off lookup for code that has no translator in hand. */
export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: TranslateArgs<K>): string {
  const [params] = args as unknown as [Params?];
  return render(locale, key, params);
}

/**
 * Whether `locale` translates `key` itself, as opposed to falling back to
 * English. Useful for coverage reporting, not for branching on in UI code.
 */
export function hasTranslation(locale: Locale, key: MessageKey): boolean {
  return catalogs[locale][key] !== undefined;
}
