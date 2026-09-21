/**
 * Whether a document is marked read-only.
 *
 * Read-only entries are keyed by full repo path so that two documents sharing a
 * basename (e.g. `guide/README.md` and `api/README.md`) can be protected
 * independently. Older workspaces stored basenames, so a stored entry still
 * matches by name (and by a path's basename) for backward compatibility until the
 * manager re-saves the list — at which point it becomes path-keyed and precise.
 *
 * An entry ending in `/` is a folder: `meetings/` protects everything under
 * `meetings/`, however deep, and nothing else — `meetings.md` is a different
 * document and keeps its own entry (docs/project-folders.md 6, "이 폴더를 읽기
 * 전용으로"). The trailing slash is what makes a folder a folder, so a path
 * entry can never accidentally become a prefix.
 */
export function isReadOnlyFile(
  readOnlyEntries: readonly string[],
  file: { path?: string | null; name?: string | null },
): boolean {
  if (readOnlyEntries.length === 0) return false;

  // Path match (current, collision-free).
  if (file.path && readOnlyEntries.includes(file.path)) return true;

  // Folder match: an entry with a trailing slash covers everything beneath it.
  if (file.path) {
    const normalized = file.path.replace(/^\.\//, '').replace(/^\/+/, '');
    for (const entry of readOnlyEntries) {
      if (!entry.endsWith('/')) continue;
      // A bare `/` would be "the whole repository", which the picker cannot
      // produce and which would silently freeze every document.
      const prefix = entry.replace(/^\/+/, '');
      if (prefix && normalized.startsWith(prefix)) return true;
    }
  }

  // Legacy: entries stored as a basename.
  if (file.name && readOnlyEntries.includes(file.name)) return true;
  if (file.path) {
    const base = file.path.split('/').pop();
    if (base && readOnlyEntries.includes(base)) return true;
  }

  return false;
}

/** Whether a read-only entry names a folder rather than a single document. */
export function isReadOnlyFolderEntry(entry: string): boolean {
  return entry.endsWith('/');
}
