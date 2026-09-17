import { IMPORT_STEPS, type ImportProgress, makeProgressReporter } from '../services/google/import-steps';
import { readNdjson } from '../web/src/utils/ndjson';

/**
 * The import reports its steps so the sidebar can show a progress bar. Both ends
 * of that are checked here: what the service emits, and how the browser reads a
 * stream that arrives in pieces the network chose.
 */

/** A body that hands out exactly these chunks, so the splitting is what is under test. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

async function collect<T>(body: ReadableStream<Uint8Array>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of readNdjson<T>(body)) out.push(value);
  return out;
}

describe('readNdjson', () => {
  it('reads whole lines out of chunks that split them anywhere', async () => {
    const events = await collect<{ n: number }>(streamOf(['{"n":1}\n{"n', '":2}\n', '{"n":3}\n']));
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('keeps a final line that never got its newline', async () => {
    expect(await collect(streamOf(['{"n":1}\n', '{"n":2}']))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('skips blank and unreadable lines rather than failing', async () => {
    expect(await collect(streamOf(['\n{"n":1}\n', 'not json\n', '{"n":2}\n']))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('survives a stream that was cut off mid-line', async () => {
    // The half line at the end is dropped, not thrown.
    expect(await collect(streamOf(['{"n":1}\n{"n":']))).toEqual([{ n: 1 }]);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const encoded = new TextEncoder().encode('{"label":"연구실"}\n');
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 12));
        controller.enqueue(encoded.slice(12));
        controller.close();
      },
    });
    expect(await collect(split)).toEqual([{ label: '연구실' }]);
  });
});

describe('makeProgressReporter', () => {
  it('numbers each step and names it', () => {
    const seen: ImportProgress[] = [];
    const report = makeProgressReporter((progress) => seen.push(progress));

    report('checking');
    report('committing');

    expect(seen).toEqual([
      { step: 'checking', index: 1, total: IMPORT_STEPS.length, label: 'Checking the repository' },
      { step: 'committing', index: 3, total: IMPORT_STEPS.length, label: 'Committing to GitHub' },
    ]);
  });

  it('does not let a broken listener reach the import', () => {
    const report = makeProgressReporter(() => {
      throw new Error('listener exploded');
    });
    expect(() => report('reading')).not.toThrow();
  });

  it('is a no-op when nobody is listening', () => {
    expect(() => makeProgressReporter()('reading')).not.toThrow();
  });

  it('ends on done, so a full run reaches 100%', () => {
    expect(IMPORT_STEPS[IMPORT_STEPS.length - 1]).toBe('done');
    expect(IMPORT_STEPS.indexOf('done') + 1).toBe(IMPORT_STEPS.length);
  });
});
