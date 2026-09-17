/**
 * The viewer's translation lookup: `t('common.button.cancel')`.
 *
 * Deliberately ~60 lines rather than react-i18next, and a deliberate mirror of
 * `src/i18n/index.ts` on the server: what CHOIR needs from a library is
 * compile-time key safety (a typo, or a key deleted from English, fails the
 * build) and plural selection, and `Intl.PluralRules` already solves the
 * second. No runtime catalog loading, no JSON fetch, no suspense.
 *
 * This module is plain TypeScript with no JSX so that the root jest suite can
 * import it directly; the React bindings live next door in `index.tsx`.
 */

import { en } from './locales/en';
import { ko } from './locales/ko';
import type { Locale } from './supported-locales';
import type { LocaleCatalog, MessageKey, MessageValue, Params, PluralForms, TranslateArgs } from './types';

/** Every catalog by locale, for the build-time checks and for `t`'s lookup. */
export const catalogs: Readonly<Record<Locale, LocaleCatalog>> = { en, ko };

/**
 * `{name}` rather than `${name}` so catalog entries stay inert data: a template
 * literal would be evaluated by whoever wrote the file, which defeats the point
 * of shipping strings translators can edit.
 */
export const PLACEHOLDER = /\{(\w+)\}/g;

const rulesByLocale = new Map<Locale, Intl.PluralRules>();

function rulesFor(locale: Locale): Intl.PluralRules {
  const cached = rulesByLocale.get(locale);
  if (cached) return cached;
  const rules = new Intl.PluralRules(locale);
  rulesByLocale.set(locale, rules);
  return rules;
}

/**
 * Distinguishes the two catalog value shapes at runtime. `other` is the marker
 * because it is the one form every language is required to provide.
 */
export function isPluralForms(value: unknown): value is PluralForms {
  return typeof value === 'object' && value !== null && typeof (value as PluralForms).other === 'string';
}

/**
 * Picks the form for `count`, falling back to `other` when a locale's rules ask
 * for a category the translator did not supply — a missing `few` should read
 * slightly wrong, not render as `undefined`.
 */
export function selectPluralForm(locale: Locale, forms: PluralForms, count: number): string {
  const category = rulesFor(locale).select(count);
  return forms[category] ?? forms.other;
}

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
 * Binds a locale once, at the provider, so call sites read as `t(key)` and
 * cannot accidentally mix locales inside one render.
 */
export function createT(locale: Locale): T {
  const translator = (key: MessageKey, params?: Params): string => render(locale, key, params);
  return Object.assign(translator, { locale }) as T;
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
