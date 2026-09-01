/**
 * Git tree entries for a commit that may both write and remove paths.
 *
 * Split out because the deletion contract is easy to break silently: a tree
 * entry needs `sha: null` to remove a path, and an entry carrying an empty blob
 * instead commits an empty file that looks, in the repository listing, exactly
 * like nothing happened.
 */

export interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  /** null removes the path; a blob sha writes it. */
  sha: string | null;
}

export function buildTreeEntries(
  blobs: ReadonlyArray<{ path: string; sha: string }>,
  deletions: readonly string[] = [],
): TreeEntry[] {
  const written = new Set(blobs.map((blob) => blob.path));

  return [
    ...blobs.map((blob) => ({ path: blob.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha })),
    // A path both written and deleted in one commit is a caller mistake; keeping
    // the write is the recoverable reading of it, and the delete would otherwise
    // depend on which entry Git applied last.
    ...deletions
      .filter((deletedPath) => !written.has(deletedPath))
      .map((deletedPath) => ({ path: deletedPath, mode: '100644' as const, type: 'blob' as const, sha: null })),
  ];
}
