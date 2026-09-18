import { type T, useT } from '../i18n';
import type { ImportProgress } from '../utils/import-api';

/**
 * The progress bar every import shares.
 *
 * Three screens stream the same NDJSON — the sidebar menu while a page is
 * fetched, the estimate dialog while a PDF is converted, the preview while it
 * is committed — so the bar, its sweep-before-the-first-step behaviour and the
 * step vocabulary live in one place rather than three. The styles are the ones
 * the Google Docs import already ships (`.import-progress*`).
 */

/**
 * Every step any import stream can carry, and the catalog key that says it.
 * Keyed by the `step` rather than by the `label` beside it: the label is the
 * server's own English, written before anyone knew who would be watching.
 */
const STEP_KEY = {
  checking: 'import.step.checking',
  reading: 'import.step.reading',
  fetching: 'import.step.fetching',
  converting: 'import.step.converting',
  ready: 'import.step.ready',
  committing: 'import.step.committing',
  mirroring: 'import.step.mirroring',
  indexing: 'import.step.indexing',
  linking: 'import.step.linking',
  done: 'import.step.done',
} as const satisfies Record<string, Parameters<T>[0]>;

/**
 * A server newer than this bundle can stream a step the catalog has no word
 * for. Its English `label` is a better answer there than a blank bar.
 */
export function describeImportStep(t: T, progress: ImportProgress): string {
  const key = STEP_KEY[progress.step as keyof typeof STEP_KEY];
  const sentence = key ? t(key) : progress.label;
  // A long PDF spends most of the run on one step, so the chunk counter is the
  // only thing that moves while it does.
  return progress.chunk
    ? t('import.step.chunk', { step: sentence, current: progress.chunk.current, total: progress.chunk.total })
    : sentence;
}

type ImportProgressBarProps = {
  /** Null until the first line arrives: the bar sweeps rather than sitting at zero. */
  progress: ImportProgress | null;
  ariaLabel: string;
  /** What to say before the first step lands. */
  startingLabel: string;
};

export function ImportProgressBar({ progress, ariaLabel, startingLabel }: ImportProgressBarProps) {
  const t = useT();
  const percent = progress && progress.total > 0 ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <div className="import-progress">
      <div
        className={`import-progress-track${progress ? '' : ' indeterminate'}`}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={progress ? progress.total : undefined}
        aria-valuenow={progress ? progress.index : undefined}
        aria-valuetext={progress ? describeImportStep(t, progress) : undefined}
        // Not keyboard-reachable on purpose: there is nothing to operate, and
        // the label below it carries the same words the bar shows.
        tabIndex={-1}
      >
        <div className="import-progress-fill" style={progress ? { width: `${percent}%` } : undefined} />
      </div>
      <div className="import-progress-label" aria-live="polite">
        {progress ? describeImportStep(t, progress) : startingLabel}
      </div>
    </div>
  );
}
