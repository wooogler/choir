import { KeyedMutex } from 'services/google/keyed-mutex';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedMutex', () => {
  it('serializes tasks sharing a key', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const task = (name: string, delay: number) => async () => {
      events.push(`${name}:start`);
      await tick(delay);
      events.push(`${name}:end`);
    };

    // The slow task is queued first, so a naive implementation that lets both run
    // would interleave the starts.
    await Promise.all([mutex.run('doc', task('a', 20)), mutex.run('doc', task('b', 0))]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    await Promise.all([
      mutex.run('doc-a', async () => {
        events.push('a:start');
        await tick(20);
        events.push('a:end');
      }),
      mutex.run('doc-b', async () => {
        events.push('b:start');
        await tick(0);
        events.push('b:end');
      }),
    ]);

    // b must finish while a is still sleeping.
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('does not wedge a key when a task throws', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.run('doc', async () => {
        throw new Error('publish failed');
      }),
    ).rejects.toThrow('publish failed');

    // A failed publish must not block the next poll or approval on that document.
    await expect(mutex.run('doc', async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the task result', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('doc', async () => 42)).resolves.toBe(42);
  });

  it('releases keys once nothing is queued', async () => {
    const mutex = new KeyedMutex();

    await Promise.all([mutex.run('a', async () => tick(1)), mutex.run('b', async () => tick(1))]);
    await tick(0);

    // Otherwise a long-lived process retains one promise per document it ever saw.
    expect(mutex.activeKeys).toBe(0);
  });

  it('keeps ordering under a burst on one key', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        mutex.run('doc', async () => {
          order.push(index);
          await tick(index % 3);
        }),
      ),
    );

    expect(order).toEqual(Array.from({ length: 25 }, (_unused, index) => index));
  });
});
