/**
 * The steps an import walks through, and the shape they are reported in.
 *
 * Kept apart from `import-service` so the vocabulary can be read (and tested)
 * without pulling in GitHub, Google, and the workspace mirror behind it.
 */

export const IMPORT_STEPS = ['checking', 'reading', 'committing', 'mirroring', 'linking', 'done'] as const;

export type ImportStep = (typeof IMPORT_STEPS)[number];

export interface ImportProgress {
  step: ImportStep;
  /** 1-based position of `step` within IMPORT_STEPS. */
  index: number;
  total: number;
  /** Human-readable, safe to show as-is. */
  label: string;
}

const STEP_LABELS: Record<ImportStep, string> = {
  checking: 'Checking the repository',
  reading: 'Reading the Google Doc',
  committing: 'Committing to GitHub',
  mirroring: 'Updating the local copy',
  linking: 'Linking the Google Doc',
  done: 'Done',
};

/**
 * Wraps a listener into a reporter the import can call freely: it is optional,
 * and a listener that throws must not take the import down with it — progress is
 * decoration on top of work that has already happened.
 */
export function makeProgressReporter(onProgress?: (progress: ImportProgress) => void): (step: ImportStep) => void {
  if (!onProgress) return () => {};

  return (step: ImportStep) => {
    try {
      onProgress({
        step,
        index: IMPORT_STEPS.indexOf(step) + 1,
        total: IMPORT_STEPS.length,
        label: STEP_LABELS[step],
      });
    } catch {
      // See above.
    }
  };
}
