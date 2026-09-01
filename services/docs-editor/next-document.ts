/**
 * Where the viewer goes after the document it was showing is deleted.
 *
 * The client's file list is a snapshot from page load, so this is decided on the
 * server from what actually survived.
 */

/**
 * The document that took the deleted one's place in the sorted list, or the last
 * one when the deleted document sorted last. Null when nothing is left.
 */
export function pickNextDocument(surviving: readonly string[], deletedPath: string): string | null {
  if (surviving.length === 0) return null;

  const next = surviving.find((candidate) => candidate.localeCompare(deletedPath, undefined, { numeric: true }) > 0);
  return next ?? surviving[surviving.length - 1];
}
