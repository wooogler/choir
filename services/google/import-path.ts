import path from 'node:path';

/**
 * Where an imported Google Doc may land in the repository.
 *
 * Kept apart from import-service so it stays a pure function with no service
 * graph behind it: this is the check standing between a caller-supplied string
 * and a commit, and it should be cheap to test.
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
export function normalizeImportPath(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/^\/+/, '');
  if (!trimmed) return null;

  const normalized = path.posix.normalize(trimmed);
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) return null;
  if (!/\.md$/i.test(normalized)) return null;
  if (RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;

  return normalized;
}

/** A filename suggestion from the Doc's title, for the viewer to pre-fill. */
export function suggestImportPath(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'imported-document'}.md`;
}
