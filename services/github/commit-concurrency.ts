/**
 * Concurrency guard for the Git Data API commit path. When a branch moves under
 * us between commit attempts, we rebuild our tree on the new head and re-use our
 * pre-built blobs. That silently discards a concurrent commit if it touched one
 * of the same files we are writing. Given each target path's blob SHA at the
 * base we started from and at the new head, return the first path that changed
 * between the two — the caller must abort rather than overwrite it. Returns
 * undefined when no target file was changed by the concurrent commit (so a
 * rebase-and-retry is safe).
 *
 * A missing entry (path absent from a tree) is treated as `null`, so a file that
 * was created or deleted concurrently also counts as a change.
 */
export function findConcurrentlyChangedPath(
  paths: string[],
  baseShas: Map<string, string | null>,
  headShas: Map<string, string | null>,
): string | undefined {
  return paths.find((p) => (baseShas.get(p) ?? null) !== (headShas.get(p) ?? null));
}
