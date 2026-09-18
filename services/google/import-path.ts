import { normalizeDocumentPath } from 'services/docs-editor/document-path';

/**
 * Where an imported Google Doc may land in the repository.
 *
 * The rule itself lives in `services/docs-editor/document-path`, because an
 * import and a document created in the viewer write to the same repository and
 * must refuse the same paths. This module stays as the import's name for it.
 */

/**
 * A repository-relative markdown path, or null. Rejects absolute paths, parent
 * traversal and anything that is not markdown — the mirror guards its own root,
 * but the commit goes to GitHub too, which does not.
 */
export function normalizeImportPath(candidate: string): string | null {
  return normalizeDocumentPath(candidate);
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
