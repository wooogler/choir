/**
 * Whether a document is marked read-only.
 *
 * Read-only entries are keyed by full repo path so that two documents sharing a
 * basename (e.g. `guide/README.md` and `api/README.md`) can be protected
 * independently. Older workspaces stored basenames, so a stored entry still
 * matches by name (and by a path's basename) for backward compatibility until the
 * manager re-saves the list — at which point it becomes path-keyed and precise.
 */
export function isReadOnlyFile(
  readOnlyEntries: readonly string[],
  file: { path?: string | null; name?: string | null },
): boolean {
  if (readOnlyEntries.length === 0) return false;

  // Path match (current, collision-free).
  if (file.path && readOnlyEntries.includes(file.path)) return true;

  // Legacy: entries stored as a basename.
  if (file.name && readOnlyEntries.includes(file.name)) return true;
  if (file.path) {
    const base = file.path.split('/').pop();
    if (base && readOnlyEntries.includes(base)) return true;
  }

  return false;
}
