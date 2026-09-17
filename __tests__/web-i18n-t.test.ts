// What `t` and the date helpers actually do at a call site: fill holes, fall
// back to English per key rather than per file, pick a plural form by the
// locale's own rules, and say how long ago something was in the reader's
// language.
//
// These import the viewer's `.ts` modules directly (never `index.tsx`), so the
// root jest transform never has to deal with JSX.

import { formatDate, formatRelative } from '../web/src/i18n/format';
import { en } from '../web/src/i18n/locales/en';
import { ko } from '../web/src/i18n/locales/ko';
import { createT, hasTranslation, isPluralForms, selectPluralForm, translate } from '../web/src/i18n/translate';
import type { LocaleCatalog } from '../web/src/i18n/types';

describe('web t()', () => {
  it('carries the locale it was bound to', () => {
    expect(createT('ko').locale).toBe('ko');
  });

  it('renders a plain string', () => {
    expect(createT('en')('common.button.cancel')).toBe('Cancel');
    expect(createT('ko')('common.button.cancel')).toBe('취소');
  });

  it('fills {name} holes', () => {
    expect(createT('en')('viewer.notice.committed', { sha: 'a1b2c3d' })).toBe(
      'Committed a1b2c3d and refreshed the index.',
    );
    expect(createT('ko')('viewer.commit.defaultMessage', { path: 'docs/a.md' })).toContain('docs/a.md');
  });

  it('leaves an unknown placeholder verbatim rather than blanking it', () => {
    // A half-filled sentence is a visible bug report; an empty hole reads as a
    // finished sentence.
    expect(createT('en')('viewer.notice.committed', { nope: 'x' })).toBe('Committed {sha} and refreshed the index.');
  });

  it('interpolates the same param into several holes of one sentence', () => {
    const rendered = createT('en')('delete.body.onBranch', { path: 'docs/a.md', branch: 'main' });
    expect(rendered).toContain('docs/a.md');
    expect(rendered).toContain('main');
  });

  it('falls back to English per key, not per file', () => {
    // A catalog missing one key keeps its own translations for the rest, and the
    // hole reads as English rather than as `undefined`.
    const sparse: LocaleCatalog = { ...ko, 'common.button.cancel': undefined };
    expect(sparse['common.button.cancel']).toBeUndefined();
    expect(sparse['common.button.close']).toBe('닫기');
    expect(sparse['common.button.close'] ?? en['common.button.close']).toBe('닫기');
    expect(sparse['common.button.cancel'] ?? en['common.button.cancel']).toBe('Cancel');
  });

  it('reports a key English defines and Korean does not as untranslated', () => {
    // Every key is translated today, so the negative case is constructed rather
    // than asserted against the shipped catalog (which the catalog suite checks).
    expect(hasTranslation('en', 'viewer.readOnly')).toBe(true);
    expect(isPluralForms(en['viewer.changedBlocks'])).toBe(true);
    expect(isPluralForms(en['viewer.readOnly'])).toBe(false);
  });

  it('picks the English singular and plural by count', () => {
    const t = createT('en');
    expect(t('viewer.changedBlocks', { count: 1 })).toBe('1 changed block');
    expect(t('viewer.changedBlocks', { count: 0 })).toBe('0 changed blocks');
    expect(t('viewer.changedBlocks', { count: 7 })).toBe('7 changed blocks');
  });

  it('uses Korean’s single plural category for every count', () => {
    const t = createT('ko');
    expect(t('viewer.changedBlocks', { count: 1 })).toBe('변경된 블록 1개');
    expect(t('viewer.changedBlocks', { count: 7 })).toBe('변경된 블록 7개');
  });

  it('fills the other holes of a plural entry too', () => {
    expect(createT('en')('viewer.usage.tooltip', { count: 1, unanswered: 2 })).toBe(
      'Retrieved in 1 question (last 12 weeks); 2 unanswered',
    );
    expect(createT('en')('viewer.usage.tooltip', { count: 3, unanswered: 0 })).toBe(
      'Retrieved in 3 questions (last 12 weeks); 0 unanswered',
    );
  });

  it('falls back to `other` when a locale asks for a form the catalog lacks', () => {
    expect(selectPluralForm('en', { other: 'many' }, 1)).toBe('many');
    expect(selectPluralForm('en', { one: 'a', other: 'many' }, 1)).toBe('a');
  });

  it('translates one-off without a bound translator', () => {
    expect(translate('ko', 'common.button.close')).toBe('닫기');
  });
});

describe('web date formatting', () => {
  // A fixed instant, so the buckets are exercised rather than the clock.
  const now = Date.parse('2026-03-05T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('says "just now" under a minute, in each language', () => {
    expect(formatRelative('en', ago(10_000), now)).toBe('just now');
    expect(formatRelative('ko', ago(10_000), now)).toBe('방금');
  });

  it('keeps the compact English wording the hand-rolled helper had', () => {
    expect(formatRelative('en', ago(5 * MINUTE), now)).toBe('5m ago');
    expect(formatRelative('en', ago(3 * HOUR), now)).toBe('3h ago');
    expect(formatRelative('en', ago(2 * DAY), now)).toBe('2d ago');
  });

  it('speaks Korean rather than transliterating English', () => {
    expect(formatRelative('ko', ago(5 * MINUTE), now)).toBe('5분 전');
    expect(formatRelative('ko', ago(3 * HOUR), now)).toBe('3시간 전');
    expect(formatRelative('ko', ago(2 * DAY), now)).toBe('그저께');
  });

  it('names yesterday rather than counting to one', () => {
    // This is what `numeric: 'auto'` buys, and it is the one place the English
    // wording changes from the old helper's "1d ago".
    expect(formatRelative('en', ago(DAY), now)).toBe('yesterday');
    expect(formatRelative('ko', ago(DAY), now)).toBe('어제');
  });

  it('falls back to an absolute date past a week', () => {
    const old = ago(40 * DAY);
    expect(formatRelative('en', old, now)).toBe(formatDate('en', old));
    expect(formatRelative('en', old, now)).not.toContain('ago');
    expect(formatRelative('ko', old, now)).toBe(formatDate('ko', old));
  });

  it('formats an absolute date in the reader’s locale', () => {
    const when = '2026-03-05T12:00:00Z';
    expect(formatDate('en', when)).not.toBe(formatDate('ko', when));
  });

  it('returns an empty string for an unparseable value rather than "Invalid Date"', () => {
    expect(formatRelative('en', 'not-a-date', now)).toBe('');
    expect(formatDate('ko', 'not-a-date')).toBe('');
  });
});
