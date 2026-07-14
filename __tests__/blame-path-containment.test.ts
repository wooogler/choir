import path from 'node:path';
import { resolveContainedDocPath } from 'services/document/provenance/doc-path';

describe('resolveContainedDocPath', () => {
  const gitRoot = '/data/workspaces/T1/git';

  it('resolves a normal repo-relative path inside the clone', () => {
    const result = resolveContainedDocPath(gitRoot, 'docs/guide.md');
    expect(result).not.toBeNull();
    expect(result?.normalized).toBe('docs/guide.md');
    expect(result?.targetPath).toBe(path.join(gitRoot, 'docs/guide.md'));
  });

  it('strips leading slashes and treats the path as repo-relative', () => {
    const result = resolveContainedDocPath(gitRoot, '/docs/guide.md');
    expect(result?.normalized).toBe('docs/guide.md');
    expect(result?.targetPath).toBe(path.join(gitRoot, 'docs/guide.md'));
  });

  it('rejects a relative traversal that escapes the clone', () => {
    expect(resolveContainedDocPath(gitRoot, '../../../etc/passwd')).toBeNull();
    expect(resolveContainedDocPath(gitRoot, '../../etc/passwd')).toBeNull();
    expect(resolveContainedDocPath(gitRoot, '../etc/passwd')).toBeNull();
  });

  it('never resolves outside the clone even for absolute-rooted traversal', () => {
    // Rooted `..` normalizes back to the clone (e.g. "/../../etc" → "etc"), so the
    // target stays inside — it never points at a real file above the clone.
    const result = resolveContainedDocPath(gitRoot, '/../../etc/passwd');
    if (result) {
      expect(result.targetPath.startsWith(path.resolve(gitRoot) + path.sep)).toBe(true);
    }
  });

  it('rejects a traversal hidden in the middle of a path', () => {
    expect(resolveContainedDocPath(gitRoot, 'docs/../../etc/passwd')).toBeNull();
  });

  it('rejects the clone root itself (a directory, not a document)', () => {
    expect(resolveContainedDocPath(gitRoot, '')).toBeNull();
    expect(resolveContainedDocPath(gitRoot, '.')).toBeNull();
  });

  it('does not let a sibling directory pass a prefix check', () => {
    // "<gitRoot>-evil" shares the string prefix but is not inside the clone.
    const result = resolveContainedDocPath('/data/repo', '../repo-evil/secret.md');
    expect(result).toBeNull();
  });

  it('keeps a nested path that normalizes back inside the clone', () => {
    const result = resolveContainedDocPath(gitRoot, 'docs/./sub/../guide.md');
    expect(result?.normalized).toBe('docs/guide.md');
  });
});
