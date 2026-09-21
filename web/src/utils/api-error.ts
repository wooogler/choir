/**
 * What every viewer API client does with a refusal.
 *
 * Lifted out of `import-api.ts` when the project settings dialog needed the
 * same three things: an error object that carries the server's *code* rather
 * than its English, a way to build one from a `Response`, and a helper that
 * runs it through `describeServerError` so the reader sees their own language.
 *
 * The class is the base rather than the whole story: `ImportApiError` still
 * exists and still answers `instanceof`, so nothing that catches one had to
 * change. A client with nothing of its own to add — the project client — throws
 * `ApiError` directly.
 */

import { type ServerErrorPayload, type T, describeServerError } from '../i18n';

export class ApiError extends Error {
  readonly payload: ServerErrorPayload;
  readonly status?: number;

  constructor(payload: ServerErrorPayload, status?: number) {
    super(payload.error ?? payload.message ?? 'request failed');
    this.name = 'ApiError';
    this.payload = payload;
    this.status = status;
  }
}

/**
 * The sentence to show for a failed call.
 *
 * Anything that is not an `ApiError` — a dropped connection, a parse failure —
 * gets the caller's fallback rather than its own English message: those strings
 * were written for a console, not for a reader.
 */
export function describeApiError(t: T, error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return describeServerError(t, error.payload) ?? fallback;
  }
  return fallback;
}

/** The refusal body a non-2xx response carries, or an empty one if it carries none. */
export async function errorPayload(response: Response): Promise<ServerErrorPayload> {
  return (await response.json().catch(() => ({}))) as ServerErrorPayload;
}
