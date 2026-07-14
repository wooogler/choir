import path from 'node:path';

/**
 * Resolves a request-supplied `docPath` against the local git clone, refusing any
 * path that escapes it. The provenance route hands us the raw URL splat, so a
 * value like `../../../etc/passwd` must not be allowed to read outside the clone.
 * Returns the repo-relative normalized path plus the absolute target, or null if
 * the path is not contained.
 */
export function resolveContainedDocPath(
  gitRoot: string,
  docPath: string,
): { normalized: string; targetPath: string } | null {
  const gitRootResolved = path.resolve(gitRoot);
  // Normalize `.`/`..`/duplicate separators, then strip any leading slashes so the
  // path is treated as repo-relative. Any surviving `..` that escapes the clone is
  // rejected by the containment check below (matching mirror-service semantics).
  const normalized = path.posix.normalize(docPath).replace(/^\/+/, '');
  const targetPath = path.resolve(gitRootResolved, normalized);
  // Trailing separator so a sibling like "<gitRoot>-evil" can't pass startsWith.
  if (targetPath === gitRootResolved || !targetPath.startsWith(gitRootResolved + path.sep)) {
    return null;
  }
  return { normalized, targetPath };
}
