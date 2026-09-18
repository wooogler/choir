import path from 'node:path';

/**
 * Where a document may land in the repository, and what it is called.
 *
 * Kept apart from the services that commit, so it stays a pure function with no
 * service graph behind it: this is the check standing between a caller-supplied
 * string and a commit, and it should be cheap to test. Shared by the Google Docs
 * import and by the viewer's "New document", which write to the same repository
 * and must refuse the same paths.
 */

/**
 * `assets/` holds committed binaries and `.choir/` holds encrypted provenance.
 * Neither is a place a document may be written by name. (The former mirrors
 * ASSETS_DIR in services/docs-editor/save-asset, which is not imported here to
 * keep this module free of the GitHub client.)
 */
const RESERVED_PREFIXES = ['assets/', '.choir/'];

/**
 * A repository-relative markdown path, or null. Rejects absolute paths, parent
 * traversal and anything that is not markdown — the mirror guards its own root,
 * but the commit goes to GitHub too, which does not.
 */
export function normalizeDocumentPath(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/^\/+/, '');
  if (!trimmed) return null;

  // The extension is lowercased rather than merely accepted: the mirror walk in
  // app.ts and deleteDocument both match `.md` case-sensitively, so a document
  // committed as `Policy.MD` would exist in the repository and never appear in
  // the sidebar.
  const normalized = path.posix.normalize(trimmed).replace(/\.md$/i, '.md');
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) return null;
  if (!normalized.endsWith('.md')) return null;
  // `.choir` bare as well as `.choir/…`, the form the delete route refuses: the
  // extension check already covers it today, but the reserved name should not
  // depend on that for its safety.
  if (normalized === '.choir' || RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;

  return normalized;
}

/**
 * The human title a document path stands for, derived the way the viewer's
 * `formatTitle` derives it, so a file created with a generated heading reads the
 * same in the sidebar as in its own first line.
 */
export function documentTitleFromPath(filePath: string): string {
  return (
    filePath
      .split('/')
      .pop()
      ?.replace(/\.md$/i, '')
      .replace(/^\d+[-_\s]*/, '')
      .replace(/[-_]+/g, ' ')
      .trim() || filePath
  );
}
