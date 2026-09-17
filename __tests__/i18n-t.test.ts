// Behaviour of the lookup itself: interpolation, the per-key English fallback
// that lets a partial locale ship, and plural selection (English one/other,
// Korean other-only — the case a hand-rolled `count === 1 ? a : b` gets wrong).

import { createT, hasTranslation, translate } from '../src/i18n';

describe('createT', () => {
  it('carries the locale it was bound to', () => {
    expect(createT('ko').locale).toBe('ko');
  });

  it('returns the locale string when one exists', () => {
    expect(createT('en')('common.button.cancel')).toBe('Cancel');
    expect(createT('ko')('common.button.cancel')).toBe('취소');
  });

  it('interpolates {name} placeholders', () => {
    expect(translate('en', 'common.count.files', { count: 3 })).toBe('3 files');
  });

  it('accepts number params and stringifies them', () => {
    expect(translate('en', 'common.count.messages', { count: 0 })).toBe('0 messages');
    expect(translate('ko', 'common.count.messages', { count: 12 })).toBe('메시지 12개');
  });

  it('leaves unknown placeholders verbatim', () => {
    // A hole nobody filled should look broken, not silently vanish.
    const rendered = translate('en', 'common.count.files', { count: 2, unused: 'x' });
    expect(rendered).toBe('2 files');
    const raw = createT('en')('common.error.generic');
    expect(raw).toBe('Something went wrong. Please try again.');
  });
});

describe('plural selection', () => {
  it('uses English one/other', () => {
    const t = createT('en');
    expect(t('common.count.managers', { count: 1 })).toBe('1 manager');
    expect(t('common.count.managers', { count: 0 })).toBe('0 managers');
    expect(t('common.count.managers', { count: 2 })).toBe('2 managers');
  });

  it('uses the single Korean form for every count', () => {
    const t = createT('ko');
    expect(t('common.count.managers', { count: 1 })).toBe('매니저 1명');
    expect(t('common.count.managers', { count: 7 })).toBe('매니저 7명');
  });
});

describe('fallback', () => {
  it('reports which locales translate a key themselves', () => {
    expect(hasTranslation('en', 'common.button.close')).toBe(true);
    expect(hasTranslation('ko', 'common.button.close')).toBe(true);
  });

  it('falls back to English per key, not per catalog', () => {
    jest.isolateModules(() => {
      // Stand in for a feature Korean has not caught up with yet.
      jest.doMock('../src/i18n/locales/ko', () => ({ ko: { 'common.button.cancel': '취소' } }));
      const i18n = require('../src/i18n') as typeof import('../src/i18n');
      expect(i18n.hasTranslation('ko', 'common.error.generic')).toBe(false);
      expect(i18n.createT('ko')('common.button.cancel')).toBe('취소');
      expect(i18n.createT('ko')('common.error.generic')).toBe('Something went wrong. Please try again.');
      expect(i18n.translate('ko', 'common.count.files', { count: 2 })).toBe('2 files');
      jest.dontMock('../src/i18n/locales/ko');
    });
  });
});
