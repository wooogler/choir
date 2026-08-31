/**
 * Serializes async work per key.
 *
 * Every Google Docs replica operation for a given document — the three publish
 * hooks, the drift poller, and the approve/reject flow — reads and writes the
 * same sync state and baseline file. Without serialization the poller can export
 * a half-pushed document, compare it against the previous baseline and report
 * drift that never happened, while two writers race on the state file and one
 * loses its update.
 *
 * Deliberately NOT a single-flight cache: coalescing two publishes of the same
 * document would drop the newer content. Serializing and letting the publisher's
 * content-hash guard skip redundant work gets the same saving without that risk.
 */
export class KeyedMutex {
  private readonly queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const entry = this.queues.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
    entry.waiting += 1;
    this.queues.set(key, entry);

    // Chain onto the previous holder whether it resolved or rejected: one task's
    // failure must not wedge the key forever.
    const result = entry.tail.then(task, task);
    entry.tail = result.catch(() => undefined);

    try {
      return await result;
    } finally {
      entry.waiting -= 1;
      // Drop the key once nothing is queued behind us, so a long-lived process
      // doesn't retain one promise per document it has ever touched.
      if (entry.waiting === 0 && this.queues.get(key) === entry) {
        this.queues.delete(key);
      }
    }
  }

  /** Number of keys currently held or queued. Exposed for tests and diagnostics. */
  get activeKeys(): number {
    return this.queues.size;
  }
}

/**
 * Process-wide lock for replica work. Keyed per (workspace, document) for the
 * publish/poll/approve path, and per workspace for whole-file state writes.
 *
 * This is an in-process lock, so the deployment invariant in
 * docs/google-drive-sync.md holds: exactly one process owns a given data
 * directory. Two CHOIR instances sharing `data/` would race past it.
 */
export const replicaLock = new KeyedMutex();

export function docKey(workspaceId: string, githubPath: string): string {
  return `doc:${workspaceId}:${githubPath}`;
}

export function workspaceKey(workspaceId: string): string {
  return `ws:${workspaceId}`;
}
