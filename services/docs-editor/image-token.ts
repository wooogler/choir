import { signPayload, verifyPayload } from './signed-payload';

const PURPOSE = 'docs-image';
// Slack renders answer images by fetching the URL itself (no session cookie),
// and may re-fetch when users scroll message history, so the token must outlive
// the message. It only authorizes a single (workspace, path) pair, so a long TTL
// does not widen the blast radius — a leaked token still cannot reach other files.
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface ImageTokenPayload {
  workspaceId: string;
  path: string;
}

/** Mint a signed, path-scoped token authorizing read access to one image. */
export function signImageToken(workspaceId: string, repoPath: string, ttlMs: number = DEFAULT_TTL_MS): string {
  return signPayload<ImageTokenPayload>(PURPOSE, { workspaceId, path: repoPath }, ttlMs);
}

/** True only when the token is valid and bound to exactly this workspace + path. */
export function verifyImageToken(token: string, workspaceId: string, repoPath: string): boolean {
  const result = verifyPayload<ImageTokenPayload>(PURPOSE, token);
  return result.ok && result.payload.workspaceId === workspaceId && result.payload.path === repoPath;
}
