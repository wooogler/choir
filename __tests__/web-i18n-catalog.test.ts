// The web viewer's catalogs are data, so these are the checks the compiler
// cannot make: a Korean key English no longer defines, a placeholder one locale
// fills and the other does not, a `${}` template that would have been evaluated
// by whoever wrote the file, and a counted entry missing the one plural form
// every language is required to have.
//
// The server catalogs get the same treatment in `i18n-catalog.test.ts`; the two
// suites are separate because the bundles are (the viewer has no Block Kit
// length caps to enforce).

import { en } from '../web/src/i18n/locales/en';
import { SUPPORTED_LOCALES } from '../web/src/i18n/supported-locales';
import { catalogs, isPluralForms } from '../web/src/i18n/translate';
import type { MessageValue } from '../web/src/i18n/types';

type Entry = { locale: string; key: string; value: string };

function formsOf(value: MessageValue): string[] {
  return isPluralForms(value)
    ? Object.values(value).filter((form): form is string => typeof form === 'string')
    : [value];
}

/** Every renderable string in every locale, plural forms flattened out. */
const allStrings: Entry[] = SUPPORTED_LOCALES.flatMap((locale) =>
  Object.entries(catalogs[locale]).flatMap(([key, value]) =>
    formsOf(value as MessageValue).map((form) => ({ locale, key, value: form })),
  ),
);

function placeholdersOf(value: MessageValue): Set<string> {
  const names = new Set<string>();
  for (const form of formsOf(value)) {
    const pattern = /\{(\w+)\}/g;
    let match = pattern.exec(form);
    while (match) {
      names.add(match[1]);
      match = pattern.exec(form);
    }
  }
  return names;
}

describe('web i18n catalogs', () => {
  it('ships a catalog worth having', () => {
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(100);
    expect(allStrings.length).toBeGreaterThan(0);
  });

  it('only translates keys English defines', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(catalogs[locale])) {
        expect(Object.keys(en)).toContain(key);
      }
    }
  });

  it('translates every English key into Korean', () => {
    // The viewer ships one screenful at a time: a key that quietly falls back to
    // English leaves a single English word in the middle of a Korean sentence.
    // Reported as a list so a failure names every gap at once.
    const missing = Object.keys(en).filter((key) => catalogs.ko[key as keyof typeof en] === undefined);
    expect(missing).toEqual([]);
  });

  it('requires an `other` form on every plural entry', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        if (typeof value === 'object') {
          // Compared as a pair so a failure names the offender.
          expect([key, isPluralForms(value)]).toEqual([key, true]);
        }
      }
    }
  });

  it('keeps a counted entry counted in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        const english = en[key as keyof typeof en];
        expect([key, isPluralForms(value)]).toEqual([key, isPluralForms(english as MessageValue)]);
      }
    }
  });

  it('gives every plural form a {count} to count with', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        if (!isPluralForms(value)) continue;
        for (const form of formsOf(value)) {
          expect([locale, key, form.includes('{count}')]).toEqual([locale, key, true]);
        }
      }
    }
  });

  it('never lets a translation invent or drop a placeholder', () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      for (const [key, value] of Object.entries(catalogs[locale])) {
        const english = en[key as keyof typeof en];
        const expected = [...placeholdersOf(english as MessageValue)].sort();
        const actual = [...placeholdersOf(value as MessageValue)].sort();
        expect([locale, key, actual]).toEqual([locale, key, expected]);
      }
    }
  });

  it('keeps catalog entries inert — `{name}`, never `${name}`', () => {
    for (const { locale, key, value } of allStrings) {
      expect([locale, key, value.includes('${')]).toEqual([locale, key, false]);
    }
  });

  it('never ships an empty string', () => {
    for (const { locale, key, value } of allStrings) {
      expect([locale, key, value.trim().length > 0]).toEqual([locale, key, true]);
    }
  });
});
