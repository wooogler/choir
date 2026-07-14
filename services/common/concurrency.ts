/**
 * Runs `worker` over every item with at most `limit` in flight at once, preserving
 * result order. Use it instead of `for … await` when the per-item work is I/O bound
 * (e.g. one Slack/GitHub call per item) so a large list doesn't run strictly
 * sequentially, and instead of `Promise.all(items.map(...))` when an unbounded
 * fan-out would burst into upstream rate limits.
 *
 * A worker that rejects rejects the whole call; catch inside the worker if you want
 * per-item best-effort behavior.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => runner()));
  return results;
}
