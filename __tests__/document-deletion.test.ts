import { pickNextDocument } from '../services/docs-editor/next-document';
import { buildTreeEntries } from '../services/github/commit-tree';

/**
 * The two decisions in a document deletion that are easy to get silently wrong:
 * a tree entry that writes an empty file instead of removing the path, and a
 * post-delete destination the viewer cannot reach.
 */

describe('buildTreeEntries', () => {
  it('writes blobs with their sha', () => {
    expect(buildTreeEntries([{ path: 'docs/a.md', sha: 'aaa' }])).toEqual([
      { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'aaa' },
    ]);
  });

  it('removes a path with a null sha, not an empty blob', () => {
    const entries = buildTreeEntries([], ['docs/gone.md']);

    expect(entries).toEqual([{ path: 'docs/gone.md', mode: '100644', type: 'blob', sha: null }]);
    // An empty string here would commit an empty file, which in a repository
    // listing looks very much like a successful deletion.
    expect(entries[0].sha).not.toBe('');
  });

  it('carries writes and deletions in one commit', () => {
    const entries = buildTreeEntries([{ path: 'docs/a.md', sha: 'aaa' }], ['docs/b.md', 'assets/x.png']);

    expect(entries).toHaveLength(3);
    expect(entries.filter((entry) => entry.sha === null).map((entry) => entry.path)).toEqual([
      'docs/b.md',
      'assets/x.png',
    ]);
  });

  it('keeps the write when a path is both written and deleted', () => {
    // Otherwise the outcome depends on which entry Git applied last, and the
    // recoverable reading of a caller mistake is the one that keeps content.
    const entries = buildTreeEntries([{ path: 'docs/a.md', sha: 'aaa' }], ['docs/a.md']);

    expect(entries).toEqual([{ path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'aaa' }]);
  });

  it('produces nothing for an empty commit', () => {
    expect(buildTreeEntries([], [])).toEqual([]);
  });
});

describe('pickNextDocument', () => {
  const files = ['01_First.md', '02_Second.md', 'docs/guide.md', 'README.md'].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );

  it('moves to the document that took the deleted one’s place', () => {
    // Sorted the way the file list sorts it, `docs/guide.md` follows `02_Second.md`.
    expect(files).toEqual(['01_First.md', '02_Second.md', 'docs/guide.md', 'README.md']);
    expect(pickNextDocument(files, '02_Second.md')).toBe('docs/guide.md');
  });

  it('falls back to the last document when the deleted one sorted last', () => {
    const sorted = ['01_First.md', '02_Second.md'];
    expect(pickNextDocument(sorted, 'zz_last.md')).toBe('02_Second.md');
  });

  it('returns null when the repository has nothing left', () => {
    // The viewer has no route for a workspace with no document, so it must not
    // be sent anywhere.
    expect(pickNextDocument([], 'README.md')).toBeNull();
  });

  it('sorts numerically, the way the file list does', () => {
    const sorted = ['02_Second.md', '10_Tenth.md'];
    expect(pickNextDocument(sorted, '02_Second.md')).toBe('10_Tenth.md');
  });
});
