import { type VerifyResult, signPayload, verifyPayload } from './signed-payload';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OAuthStatePayload {
  workspaceId: string;
  next: string;
  nonce: string;
}

export const OAUTH_NONCE_COOKIE = 'choir_oauth_nonce';

/**
 * Issues a signed OAuth state and returns it together with its nonce. The nonce
 * must be stored in a browser cookie and re-checked at the callback, so the flow
 * can only be completed by the same browser that began it (prevents login CSRF /
 * session fixation — a signed state alone is not bound to any browser).
 */
export function issueOAuthState(payload: Omit<OAuthStatePayload, 'nonce'>): { state: string; nonce: string } {
  const nonce = Math.random().toString(36).slice(2, 18);
  const state = signPayload<OAuthStatePayload>('docs-oauth-state', { ...payload, nonce }, OAUTH_STATE_TTL_MS);
  return { state, nonce };
}

export function verifyOAuthState(value: string): VerifyResult<OAuthStatePayload> {
  return verifyPayload<OAuthStatePayload>('docs-oauth-state', value);
}
