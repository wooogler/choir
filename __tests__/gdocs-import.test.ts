import { extractImportable } from '../services/google/gdocs-delta';
import { normalizeImportPath, suggestImportPath } from '../services/google/import-path';

/**
 * The import path writes a commit from a caller-supplied path and from bytes a
 * Google Doc happened to carry, so both are checked here: where a document may
 * land, and what survives the trip.
 */

// A one-pixel PNG, so the magic-byte sniffing sees a real image.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('normalizeImportPath', () => {
  it('accepts ordinary repository paths', () => {
    expect(normalizeImportPath('README.md')).toBe('README.md');
    expect(normalizeImportPath('policy/onboarding.md')).toBe('policy/onboarding.md');
    expect(normalizeImportPath('  spaced.md  ')).toBe('spaced.md');
    expect(normalizeImportPath('/leading-slash.md')).toBe('leading-slash.md');
  });

  it('refuses anything that is not markdown', () => {
    expect(normalizeImportPath('notes.txt')).toBeNull();
    expect(normalizeImportPath('notes')).toBeNull();
    expect(normalizeImportPath('')).toBeNull();
    expect(normalizeImportPath('   ')).toBeNull();
  });

  it('refuses escaping the repository', () => {
    expect(normalizeImportPath('../outside.md')).toBeNull();
    expect(normalizeImportPath('policy/../../outside.md')).toBeNull();
    expect(normalizeImportPath('a/../../../etc/passwd.md')).toBeNull();
  });

  it('refuses the directories that hold provenance and binaries', () => {
    expect(normalizeImportPath('.choir/context/thing.md')).toBeNull();
    expect(normalizeImportPath('assets/thing.md')).toBeNull();
  });

  it('collapses redundant segments rather than trusting them', () => {
    expect(normalizeImportPath('policy/./onboarding.md')).toBe('policy/onboarding.md');
    expect(normalizeImportPath('policy/drafts/../onboarding.md')).toBe('policy/onboarding.md');
  });
});

describe('suggestImportPath', () => {
  it('turns a title into a filename', () => {
    expect(suggestImportPath('Lab Onboarding Policy')).toBe('lab-onboarding-policy.md');
    expect(suggestImportPath('Q3 / Q4 — plans!')).toBe('q3-q4-plans.md');
  });

  it('keeps Hangul, which is ordinary in these documents', () => {
    expect(suggestImportPath('연구실 규정')).toBe('연구실-규정.md');
  });

  it('always produces something usable', () => {
    expect(suggestImportPath('')).toBe('imported-document.md');
    expect(suggestImportPath('!!!')).toBe('imported-document.md');
  });
});

describe('extractImportable', () => {
  it('leaves plain text alone', () => {
    const { markdown, assets, rejected } = extractImportable('# Title\n\nA paragraph.\n');
    expect(markdown).toBe('# Title\n\nA paragraph.\n');
    expect(assets).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });

  it('turns an embedded image into a committable asset', () => {
    const exported = [
      '# Title',
      '',
      '![a picture][image1]',
      '',
      `[image1]: <data:image/png;base64,${PNG_BASE64}>`,
    ].join('\n');

    const { markdown, assets, rejected } = extractImportable(exported);

    expect(rejected).toHaveLength(0);
    expect(assets).toHaveLength(1);
    expect(assets[0].extension).toBe('png');
    expect(markdown).toContain(`![a picture](assets/${assets[0].hash}.png)`);
    // The bookkeeping labels are internal and must not reach the repository.
    expect(markdown).not.toContain('img-');
    expect(markdown).not.toContain('data:image');
  });

  it('drops an image it will not commit rather than leaving a broken reference', () => {
    // An SVG is refused outright: it can carry script and would be served from
    // the docs origin, which holds the session cookie.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
    const exported = ['![diagram][image1]', '', `[image1]: <data:image/svg+xml;base64,${svg}>`].join('\n');

    const { markdown, assets, rejected } = extractImportable(exported);

    expect(assets).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(markdown).not.toContain('img-');
    expect(markdown).not.toContain('diagram]');
  });
});
