import {
  COMMIT_STEPS,
  CONVERT_STEPS,
  type ImportStepProgress,
  makeCommitReporter,
  makeConvertReporter,
} from '../services/import/progress';

/**
 * Progress is decoration on top of work that has already happened. What is
 * tested here is that it says where it is in the right phase, and that it cannot
 * take an import down when the client has gone away.
 */

describe('makeConvertReporter', () => {
  it('numbers a source event within the conversion phase', () => {
    const seen: ImportStepProgress[] = [];
    const report = makeConvertReporter((progress) => seen.push(progress));

    report({ step: 'checking', label: 'Checking the PDF' });
    report({ step: 'converting', label: 'Converting pages 1–20' });
    report({ step: 'ready', label: 'Ready' });

    expect(seen).toEqual([
      { step: 'checking', index: 1, total: 4, label: 'Checking the PDF' },
      { step: 'converting', index: 3, total: 4, label: 'Converting pages 1–20' },
      { step: 'ready', index: 4, total: 4, label: 'Ready' },
    ]);
    expect(CONVERT_STEPS).toHaveLength(4);
  });

  it('falls back to the English label when the source gave none', () => {
    const seen: ImportStepProgress[] = [];
    makeConvertReporter((progress) => seen.push(progress))({ step: 'fetching', label: '  ' });

    expect(seen[0].label).toBe('Fetching the source');
  });

  it('carries sub-progress as `chunk`, so it cannot be mistaken for the step count', () => {
    const seen: ImportStepProgress[] = [];
    const report = makeConvertReporter((progress) => seen.push(progress));

    report({ step: 'converting', label: 'Chunk 2 of 5', current: 2, total: 5 });

    expect(seen[0]).toEqual({
      step: 'converting',
      index: 3,
      total: CONVERT_STEPS.length,
      label: 'Chunk 2 of 5',
      chunk: { current: 2, total: 5 },
    });
  });

  it('omits a half-reported chunk', () => {
    const seen: ImportStepProgress[] = [];
    const report = makeConvertReporter((progress) => seen.push(progress));

    report({ step: 'converting', label: 'x', current: 2 });
    report({ step: 'converting', label: 'x', total: 0, current: 0 });

    expect(seen.every((progress) => progress.chunk === undefined)).toBe(true);
  });

  it('swallows a listener that throws', () => {
    const report = makeConvertReporter(() => {
      throw new Error('response already closed');
    });

    expect(() => report({ step: 'ready', label: 'Ready' })).not.toThrow();
  });

  it('is a no-op without a listener', () => {
    expect(() => makeConvertReporter()({ step: 'checking', label: 'Checking' })).not.toThrow();
  });
});

describe('makeCommitReporter', () => {
  it('numbers within the commit phase, which is a different length', () => {
    const seen: ImportStepProgress[] = [];
    const report = makeCommitReporter((progress) => seen.push(progress));

    for (const step of COMMIT_STEPS) report(step);

    expect(seen.map((progress) => [progress.step, progress.index, progress.total])).toEqual([
      ['checking', 1, 5],
      ['committing', 2, 5],
      ['mirroring', 3, 5],
      ['indexing', 4, 5],
      ['done', 5, 5],
    ]);
    expect(seen.every((progress) => progress.label.length > 0)).toBe(true);
  });

  it('swallows a listener that throws, and needs none', () => {
    expect(() =>
      makeCommitReporter(() => {
        throw new Error('gone');
      })('done'),
    ).not.toThrow();
    expect(() => makeCommitReporter()('done')).not.toThrow();
  });
});
