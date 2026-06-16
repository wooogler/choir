import { type VerifyResult, signPayload, verifyPayload } from './signed-payload';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OAuthStatePayload {
  workspaceId: string;
  next: string;
  nonce: string;
}

export function issueOAuthState(payload: Omit<OAuthStatePayload, 'nonce'>): string {
  const nonce = Math.random().toString(36).slice(2, 18);
  return signPayload<OAuthStatePayload>('docs-oauth-state', { ...payload, nonce }, OAUTH_STATE_TTL_MS);
}

export function verifyOAuthState(value: string): VerifyResult<OAuthStatePayload> {
  return verifyPayload<OAuthStatePayload>('docs-oauth-state', value);
}
