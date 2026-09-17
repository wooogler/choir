/**
 * Reads a newline-delimited JSON body, yielding each line as it arrives.
 *
 * A chunk boundary lands wherever the network puts it, so the tail of a chunk is
 * usually half a line; it waits in the buffer until the rest of it turns up.
 * Lines that will not parse are skipped rather than thrown: they cost a progress
 * update, not the request.
 */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        try {
          yield JSON.parse(line) as T;
        } catch {
          // Not readable, not fatal.
        }
      }
      newline = buffered.indexOf('\n');
    }

    if (done) break;
  }

  // A last line with no trailing newline still counts.
  const tail = buffered.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as T;
    } catch {
      // Same again: a truncated tail is not worth failing over.
    }
  }
}
