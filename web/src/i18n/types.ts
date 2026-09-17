/**
 * The viewer catalog's value shapes and the call-site types derived from English.
 *
 * A deliberate mirror of `src/i18n/types.ts` on the server side: same value
 * shapes, same per-key fallback, same `{name}` placeholders. The two catalogs
 * are separate on purpose — the viewer ships its own bundle and has none of
 * Slack's length limits — but a translator moving between them should not have
 * to learn a second set of conventions.
 *
 * Keeping these out of `translate.ts` lets the catalogs stay import-free plain
 * data while `t` still gets its key union from them: the dependency runs
 * catalog -> types -> t, never back.
 */

import type { en } from './locales/en';

/** Only primitives interpolate; anything richer belongs in the call site. */
export type ParamValue = string | number;

export type Params = Record<string, ParamValue>;

/**
 * A counted string. `other` is required because it is the only category every
 * language has (Korean has nothing else); the rest are filled in per locale.
 */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

export type MessageValue = string | PluralForms;

/** What a non-English locale ships: an overlay, resolved per key, not per file. */
export type LocaleCatalog = Partial<Record<MessageKey, MessageValue>>;

export type Catalog = typeof en;

export type MessageKey = keyof Catalog;

export type PluralParams = Params & { count: number };

/**
 * A plural entry cannot be rendered without a count, so the type system asks
 * for one: keys whose English value is a plural object take a required params
 * object with `count`, everything else takes optional params. A caller holding
 * a widened `MessageKey` (rather than a literal) falls on the strict side and
 * must pass a count.
 */
export type TranslateArgs<K extends MessageKey> = [Extract<Catalog[K], { readonly other: string }>] extends [never]
  ? [params?: Params]
  : [params: PluralParams];
