import { mapWithConcurrency } from 'services/common/concurrency';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('mapWithConcurrency', () => {
  it('processes every item and preserves result order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        inFlight -= 1;
      },
    );
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallelized, not sequential
  });

  it('handles an empty list without spawning workers', async () => {
    const results = await mapWithConcurrency([], 8, async () => {
      throw new Error('worker should not run');
    });
    expect(results).toEqual([]);
  });

  it('caps workers at the item count when the limit is larger', async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 100, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('rejects if a worker throws', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
