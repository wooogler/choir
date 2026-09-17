/**
 * Turns a caught `unknown` into a sentence the reader can read.
 *
 * Every Slack handler ends the same way: a translated frame — "❌ Couldn't
 * apply the update: {reason}" — with an English `{reason}` poured into it,
 * because `error.message` is written wherever the throw was. This is the one
 * place that gap is closed, so handlers say `describeError(t, error)` and stop
 * repeating `error instanceof Error ? error.message : 'Unknown error'`.
 *
 * Three cases, in order:
 *   1. a CHOIRError whose `code` names a catalog entry → the reader's language,
 *      with the throw site's `params` filled in;
 *   2. any other Error → its English message, unchanged. Not every failure can
 *      be phrased as an action, and a real GitHub or OpenAI sentence beats a
 *      translated shrug;
 *   3. anything else (a rejected non-Error, a thrown string) → `errors.unknown`.
 */

import type { ErrorCode } from 'services/common/choir-error';
import { CHOIRError } from 'services/common/error-handler';
import { type MessageKey, type T, en } from '../../src/i18n';

/**
 * The catalog keys this module may render. Narrowing to `errors.*` is what
 * keeps `t(key, params)` callable with optional params: a widened `MessageKey`
 * could name a plural entry, and plurals demand a `count`.
 */
type ErrorMessageKey = Extract<MessageKey, `errors.${string}`>;

/**
 * The compile-time tie between the write side and the read side: every member
 * of `ErrorCode` must have an `errors.<code>` entry in English. Adding a code
 * without its string fails here rather than in a customer's workspace.
 */
type TranslatedCode = ErrorMessageKey extends `errors.${infer Code}` ? Code : never;
type UntranslatedCode = Exclude<ErrorCode, TranslatedCode>;
const _codesAreTranslated: [UntranslatedCode] extends [never]
  ? true
  : ['missing catalog entry for error code', UntranslatedCode] = true;
void _codesAreTranslated;

function catalogKeyOf(error: CHOIRError): ErrorMessageKey | undefined {
  const key = `errors.${error.code}`;
  return key in en ? (key as ErrorMessageKey) : undefined;
}

export function describeError(t: T, error: unknown): string {
  if (error instanceof CHOIRError) {
    const key = catalogKeyOf(error);
    if (key) return t(key, error.params);
  }
  // An Error with an empty message says nothing, so it is as unknown as a
  // thrown string.
  if (error instanceof Error && error.message.trim()) return error.message;
  return t('errors.unknown');
}
