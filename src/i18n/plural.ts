/**
 * Cardinal plural selection.
 *
 * CHOIR has roughly twenty counted nouns, which is far too few to justify an
 * ICU message-format dependency, and `Intl.PluralRules` already knows every
 * language's category rules (English one/other, Korean other only). Rule
 * objects are cached because constructing one is the expensive part.
 */

import type { Locale } from './supported-locales';
import type { PluralForms } from './types';

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
 * Picks the form for `count`, falling back to `other` when a locale's rules
 * ask for a category the translator did not supply — a missing `few` should
 * read slightly wrong, not render as `undefined`.
 */
export function selectPluralForm(locale: Locale, forms: PluralForms, count: number): string {
  const category = rulesFor(locale).select(count);
  return forms[category] ?? forms.other;
}
