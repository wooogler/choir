import { type VerifyResult, signPayload, verifyPayload } from './signed-payload';

export const SESSION_COOKIE_NAME = 'choir_docs_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface DocsSessionPayload {
  workspaceId: string;
  userId: string;
}

export function issueSessionCookieValue(payload: DocsSessionPayload, ttlMs: number = SESSION_TTL_MS): string {
  return signPayload<DocsSessionPayload>('docs-session', payload, ttlMs);
}

export function verifySessionCookieValue(value: string): VerifyResult<DocsSessionPayload> {
  return verifyPayload<DocsSessionPayload>('docs-session', value);
}

export function parseSessionCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const eqIndex = cookie.indexOf('=');
    if (eqIndex < 0) continue;
    const name = cookie.slice(0, eqIndex).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const raw = cookie.slice(eqIndex + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function buildSessionCookieHeader(value: string, options?: { secure?: boolean; ttlMs?: number }): string {
  const maxAge = Math.floor((options?.ttlMs ?? SESSION_TTL_MS) / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (options?.secure !== false) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function buildClearSessionCookieHeader(options?: { secure?: boolean }): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options?.secure !== false) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
