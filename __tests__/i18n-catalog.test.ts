// The catalogs are data, so these are the checks a compiler cannot make:
// Block Kit length caps (a Korean string that overflows a modal title breaks
// the view, not just the layout), placeholder drift between locales, and
// mrkdwn markers a translator left unpaired.

import {
  type MessageValue,
  SLACK_LIMITS,
  assertWithinSlackLimit,
  catalogs,
  en,
  isPluralForms,
  kindOfKey,
} from '../src/i18n';
import { SUPPORTED_LOCALES } from '../src/i18n/supported-locales';

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

describe('i18n catalogs', () => {
  it('ships at least the shared catalog', () => {
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(10);
    expect(allStrings.length).toBeGreaterThan(0);
  });

  it('only translates keys English defines', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(catalogs[locale])) {
        expect(Object.keys(en)).toContain(key);
      }
    }
  });

  it('requires an `other` form on every plural entry', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        if (typeof value === 'object') {
          expect([key, isPluralForms(value)]).toEqual([key, true]);
        }
      }
    }
  });

  it('keeps every string within its Slack length limit, in every locale', () => {
    for (const { locale, key, value } of allStrings) {
      const kind = kindOfKey(key);
      // Compared as an object so a failure names the offender and its budget.
      const seen = { locale, key, kind, limit: SLACK_LIMITS[kind], length: value.length };
      expect({ ...seen, withinLimit: assertWithinSlackLimit(kind, value) }).toEqual({ ...seen, withinLimit: true });
    }
  });

  it('never lets a translation invent a placeholder English does not fill', () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      for (const [key, value] of Object.entries(catalogs[locale])) {
        const source = placeholdersOf(en[key as keyof typeof en]);
        for (const name of placeholdersOf(value as MessageValue)) {
          expect([locale, key, name, source.has(name)]).toEqual([locale, key, name, true]);
        }
      }
    }
  });

  it('balances mrkdwn emphasis markers', () => {
    for (const { locale, key, value } of allStrings) {
      for (const marker of ['*', '_']) {
        const count = value.split(marker).length - 1;
        expect([locale, key, marker, count % 2]).toEqual([locale, key, marker, 0]);
      }
    }
  });

  it('uses {name} interpolation, never a template literal', () => {
    for (const { locale, key, value } of allStrings) {
      expect([locale, key, value.includes('${')]).toEqual([locale, key, false]);
    }
  });

  it('reads the length kind off the most specific key segment', () => {
    expect(kindOfKey('common.button.cancel')).toBe('button');
    expect(kindOfKey('docs.modal.title')).toBe('title');
    expect(kindOfKey('docs.modal.submit')).toBe('button');
    expect(kindOfKey('docs.search.placeholder')).toBe('placeholder');
    expect(kindOfKey('docs.filter.option.archived')).toBe('option');
    expect(kindOfKey('docs.option.title')).toBe('title');
    expect(kindOfKey('common.error.generic')).toBe('text');
  });
});
