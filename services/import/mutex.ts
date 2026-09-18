import { KeyedMutex, workspaceKey } from 'services/google/keyed-mutex';
import { ImportRefusal } from './types';

/**
 * One conversion at a time per workspace.
 *
 * A conversion is the expensive half of import: a PDF transcription spends the
 * workspace's own OpenAI key for a minute or more, and a page fetch holds the
 * whole document in memory. Letting a workspace run several at once multiplies
 * both without making any of them finish sooner, so the second request is
 * refused rather than queued — a manager watching a progress bar that has not
 * started is worse than being told to try again, and the browser would sit on
 * an open NDJSON stream for the length of somebody else's import.
 *
 * `KeyedMutex` (services/google/keyed-mutex.ts) queues rather than refuses, so
 * the refusal lives here: `held` records which keys are taken, and the mutex
 * underneath keeps the guarantee honest if a caller ever reaches `run` directly.
 */

const conversionLock = new KeyedMutex();
const held = new Set<string>();

/** True when a conversion is running for this workspace right now. */
export function isImportBusy(workspaceId: string): boolean {
  return held.has(workspaceKey(workspaceId));
}

/**
 * Runs `task` as this workspace's only conversion, or throws `import_busy`.
 *
 * The check and the claim happen in the same synchronous step, so two requests
 * that arrive in the same tick cannot both pass: JavaScript gives that for free,
 * and it is the reason this does not need the mutex's queue to be correct.
 */
export async function runExclusiveImport<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  const key = workspaceKey(workspaceId);
  if (held.has(key)) {
    throw new ImportRefusal(409, 'import_busy');
  }

  held.add(key);
  try {
    return await conversionLock.run(key, task);
  } finally {
    held.delete(key);
  }
}
