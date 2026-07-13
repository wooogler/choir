import { findConcurrentlyChangedPath } from '../services/github/commit-concurrency';

const shas = (entries: Record<string, string | null>) => new Map(Object.entries(entries));

describe('findConcurrentlyChangedPath', () => {
  it('returns undefined when no target file changed between base and head', () => {
    const paths = ['docs/guide.md', '.choir/context/abc.json.enc'];
    const base = shas({ 'docs/guide.md': 'aaa', '.choir/context/abc.json.enc': null });
    const head = shas({ 'docs/guide.md': 'aaa', '.choir/context/abc.json.enc': null });
    expect(findConcurrentlyChangedPath(paths, base, head)).toBeUndefined();
  });

  it('flags a file that a concurrent commit modified (would be silently overwritten)', () => {
    const paths = ['docs/guide.md'];
    const base = shas({ 'docs/guide.md': 'aaa' });
    const head = shas({ 'docs/guide.md': 'bbb' }); // someone else committed
    expect(findConcurrentlyChangedPath(paths, base, head)).toBe('docs/guide.md');
  });

  it('flags a file created concurrently (absent at base, present at head)', () => {
    const paths = ['docs/new.md'];
    const base = shas({ 'docs/new.md': null });
    const head = shas({ 'docs/new.md': 'ccc' });
    expect(findConcurrentlyChangedPath(paths, base, head)).toBe('docs/new.md');
  });

  it('flags a file deleted concurrently (present at base, absent at head)', () => {
    const paths = ['docs/gone.md'];
    const base = shas({ 'docs/gone.md': 'ddd' });
    const head = shas({ 'docs/gone.md': null });
    expect(findConcurrentlyChangedPath(paths, base, head)).toBe('docs/gone.md');
  });

  it('ignores concurrent changes to files we are not committing', () => {
    // Only "docs/guide.md" is our target; "other.md" changing is irrelevant.
    const paths = ['docs/guide.md'];
    const base = shas({ 'docs/guide.md': 'aaa', 'other.md': 'x' });
    const head = shas({ 'docs/guide.md': 'aaa', 'other.md': 'y' });
    expect(findConcurrentlyChangedPath(paths, base, head)).toBeUndefined();
  });

  it('treats a missing map entry as absent (null)', () => {
    const paths = ['docs/guide.md'];
    expect(findConcurrentlyChangedPath(paths, shas({}), shas({}))).toBeUndefined();
    expect(findConcurrentlyChangedPath(paths, shas({ 'docs/guide.md': 'aaa' }), shas({}))).toBe('docs/guide.md');
  });

  it('returns the first clashing path when several changed', () => {
    const paths = ['a.md', 'b.md'];
    const base = shas({ 'a.md': '1', 'b.md': '2' });
    const head = shas({ 'a.md': '9', 'b.md': '9' });
    expect(findConcurrentlyChangedPath(paths, base, head)).toBe('a.md');
  });
});
