import { isReadOnlyFile, isReadOnlyFolderEntry } from 'services/workspace/read-only';

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

// A folder entry is what "이 폴더를 읽기 전용으로" writes (docs/project-folders.md 6).
// The trailing slash is the whole distinction, so the case that matters most is
// the one where it is absent: `meetings.md` is a document, not the folder.
describe('isReadOnlyFile, folder entries', () => {
  const entries = ['meetings/'];

  it('protects every document under the folder, at any depth', () => {
    expect(isReadOnlyFile(entries, { path: 'meetings/2026-09-20.md', name: '2026-09-20.md' })).toBe(true);
    expect(isReadOnlyFile(entries, { path: 'meetings/2026/q3.md', name: 'q3.md' })).toBe(true);
  });

  it('does NOT match a file whose name merely starts the same', () => {
    expect(isReadOnlyFile(entries, { path: 'meetings.md', name: 'meetings.md' })).toBe(false);
    expect(isReadOnlyFile(entries, { path: 'meetings-archive/old.md', name: 'old.md' })).toBe(false);
  });

  it('does not reach into a like-named folder somewhere else', () => {
    expect(isReadOnlyFile(entries, { path: 'projects/alpha/meetings/notes.md', name: 'notes.md' })).toBe(false);
    expect(isReadOnlyFile(['projects/alpha/'], { path: 'projects/alpha/meetings/notes.md' })).toBe(true);
  });

  it('leaves exact paths and legacy basenames working alongside it', () => {
    const mixed = ['meetings/', 'guide/README.md', 'legacy.md'];
    expect(isReadOnlyFile(mixed, { path: 'meetings/a.md', name: 'a.md' })).toBe(true);
    expect(isReadOnlyFile(mixed, { path: 'guide/README.md', name: 'README.md' })).toBe(true);
    expect(isReadOnlyFile(mixed, { path: 'anywhere/legacy.md', name: 'legacy.md' })).toBe(true);
    expect(isReadOnlyFile(mixed, { path: 'docs/intro.md', name: 'intro.md' })).toBe(false);
  });

  it('refuses a bare slash rather than freezing the whole repository', () => {
    expect(isReadOnlyFile(['/'], { path: 'docs/intro.md', name: 'intro.md' })).toBe(false);
  });
});

describe('isReadOnlyFolderEntry', () => {
  it('is the trailing slash and nothing else', () => {
    expect(isReadOnlyFolderEntry('meetings/')).toBe(true);
    expect(isReadOnlyFolderEntry('meetings.md')).toBe(false);
    expect(isReadOnlyFolderEntry('guide/README.md')).toBe(false);
  });
});
