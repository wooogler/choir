import type { ImportProgressEvent, ImportProgressListener } from './types';

/**
 * The steps an import walks through, and the shape the viewer receives them in.
 *
 * Two lists, because import is two requests: a conversion that reads a source,
 * and a commit that writes a document. Each is its own progress bar, so each
 * needs its own denominator — one combined list would show "step 3 of 9" for a
 * conversion that ends at 4.
 *
 * `step` is the stable key the client maps to a sentence in the reader's
 * language; `label` is English, for logs and for a client that has no word for a
 * step yet. Same contract as the Google Docs import this generalizes
 * (services/google/import-steps.ts), which keeps its own list until the route
 * that owns it moves over.
 */

export const CONVERT_STEPS = ['checking', 'fetching', 'converting', 'ready'] as const;
export const COMMIT_STEPS = ['checking', 'committing', 'mirroring', 'indexing', 'done'] as const;

export type ImportConvertStep = (typeof CONVERT_STEPS)[number];
export type ImportCommitStep = (typeof COMMIT_STEPS)[number];

export const CONVERT_STEP_LABELS: Record<ImportConvertStep, string> = {
  checking: 'Checking the file',
  fetching: 'Fetching the source',
  converting: 'Converting to markdown',
  ready: 'Ready to review',
};

export const COMMIT_STEP_LABELS: Record<ImportCommitStep, string> = {
  checking: 'Checking the repository',
  committing: 'Committing to GitHub',
  mirroring: 'Updating the local copy',
  indexing: 'Updating the search index',
  done: 'Done',
};

export interface ImportStepProgress {
  step: ImportConvertStep | ImportCommitStep;
  /** 1-based position of `step` within its list. */
  index: number;
  /** How many steps this phase has. */
  total: number;
  /** Human-readable English, safe to show as-is. */
  label: string;
  /**
   * Progress *within* a step — PDF chunk 2 of 5. Nested rather than flat so it
   * cannot be confused with the step counter above it, which is the mistake the
   * source event shape (`current`/`total` beside nothing else) invites.
   */
  chunk?: { current: number; total: number };
}

export type ImportProgressSink = (progress: ImportStepProgress) => void;

/**
 * Turns what a source reports into what the route streams.
 *
 * Progress is decoration on top of work that has already happened, so a sink
 * that throws — a closed NDJSON response, most likely — must not take the
 * conversion down with it.
 */
export function makeConvertReporter(onEvent?: ImportProgressSink): ImportProgressListener {
  if (!onEvent) return () => {};

  return (event: ImportProgressEvent) => {
    try {
      onEvent({
        step: event.step,
        index: CONVERT_STEPS.indexOf(event.step) + 1,
        total: CONVERT_STEPS.length,
        // A source may describe what it is doing more precisely than the step
        // name can ("Converting pages 21–40"); its label wins when it has one.
        label: event.label?.trim() || CONVERT_STEP_LABELS[event.step],
        ...chunkOf(event),
      });
    } catch {
      // See above.
    }
  };
}

/** The commit side has no source to report for it, so it is driven by step alone. */
export function makeCommitReporter(onEvent?: ImportProgressSink): (step: ImportCommitStep) => void {
  if (!onEvent) return () => {};

  return (step: ImportCommitStep) => {
    try {
      onEvent({
        step,
        index: COMMIT_STEPS.indexOf(step) + 1,
        total: COMMIT_STEPS.length,
        label: COMMIT_STEP_LABELS[step],
      });
    } catch {
      // See above.
    }
  };
}

/** Sub-progress only when both halves are there; "2 of undefined" is worse than silence. */
function chunkOf(event: ImportProgressEvent): { chunk?: { current: number; total: number } } {
  if (typeof event.current !== 'number' || typeof event.total !== 'number' || event.total <= 0) return {};
  return { chunk: { current: event.current, total: event.total } };
}
