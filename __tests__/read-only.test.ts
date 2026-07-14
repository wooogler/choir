import { isReadOnlyFile } from 'services/workspace/read-only';

describe('isReadOnlyFile', () => {
  it('returns false when nothing is read-only', () => {
    expect(isReadOnlyFile([], { path: 'docs/a.md', name: 'a.md' })).toBe(false);
  });

  it('matches by full path (collision-free)', () => {
    const entries = ['guide/README.md'];
    expect(isReadOnlyFile(entries, { path: 'guide/README.md', name: 'README.md' })).toBe(true);
    // A different README.md is NOT protected when only one path is marked.
    expect(isReadOnlyFile(entries, { path: 'api/README.md', name: 'README.md' })).toBe(false);
  });

  it('still matches legacy basename entries by name', () => {
    const entries = ['README.md']; // old, basename-keyed
    expect(isReadOnlyFile(entries, { path: 'guide/README.md', name: 'README.md' })).toBe(true);
  });

  it('matches a legacy basename entry against a path with no explicit name', () => {
    const entries = ['secret.md'];
    expect(isReadOnlyFile(entries, { path: 'vault/secret.md' })).toBe(true);
  });

  it('does not match an unrelated file', () => {
    const entries = ['guide/README.md', 'legacy.md'];
    expect(isReadOnlyFile(entries, { path: 'docs/intro.md', name: 'intro.md' })).toBe(false);
  });

  it('handles a top-level file where path equals name', () => {
    expect(isReadOnlyFile(['CHANGELOG.md'], { path: 'CHANGELOG.md', name: 'CHANGELOG.md' })).toBe(true);
  });
});
