import { sanitizeNextPath } from '../services/docs-editor/safe-redirect';

describe('sanitizeNextPath (open-redirect guard)', () => {
  it('allows a plain same-origin absolute path', () => {
    expect(sanitizeNextPath('/docs/T123/guide.md')).toBe('/docs/T123/guide.md');
    expect(sanitizeNextPath('/')).toBe('/');
    expect(sanitizeNextPath('/a/b?c=1#frag')).toBe('/a/b?c=1#frag');
  });

  it('rejects a protocol-relative URL that browsers resolve off-site', () => {
    expect(sanitizeNextPath('//evil.com')).toBe('/');
    expect(sanitizeNextPath('//evil.com/path')).toBe('/');
  });

  it('rejects a backslash-variant that browsers normalize to //', () => {
    expect(sanitizeNextPath('/\\evil.com')).toBe('/');
  });

  it('rejects absolute URLs with a scheme', () => {
    expect(sanitizeNextPath('https://evil.com')).toBe('/');
    expect(sanitizeNextPath('http://evil.com')).toBe('/');
    expect(sanitizeNextPath('javascript:alert(1)')).toBe('/');
  });

  it('rejects a relative path without a leading slash', () => {
    expect(sanitizeNextPath('docs/guide.md')).toBe('/');
  });

  it('handles empty / nullish input', () => {
    expect(sanitizeNextPath('')).toBe('/');
    expect(sanitizeNextPath(undefined)).toBe('/');
    expect(sanitizeNextPath(null)).toBe('/');
  });
});
