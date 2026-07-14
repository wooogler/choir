import { readBodyCapped } from 'services/document/image-captions/fetch-remote-image';

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);

describe('readBodyCapped', () => {
  it('returns the full body when under the cap', async () => {
    const res = streamResponse([bytes(100), bytes(50)]);
    const out = await readBodyCapped(res, 1000);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(150);
  });

  it('returns null when the streamed total exceeds the cap', async () => {
    // Three 500-byte chunks = 1500, cap 1000 → aborts partway, returns null.
    const res = streamResponse([bytes(500), bytes(500), bytes(500)]);
    const out = await readBodyCapped(res, 1000);
    expect(out).toBeNull();
  });

  it('enforces the cap even when the very first chunk is too big', async () => {
    const res = streamResponse([bytes(2000)]);
    const out = await readBodyCapped(res, 1000);
    expect(out).toBeNull();
  });

  it('returns null for an empty body', async () => {
    const res = streamResponse([]);
    const out = await readBodyCapped(res, 1000);
    expect(out).toBeNull();
  });

  it('accepts a body exactly at the cap', async () => {
    const res = streamResponse([bytes(1000)]);
    const out = await readBodyCapped(res, 1000);
    expect(out?.length).toBe(1000);
  });
});
