import * as crypto from 'node:crypto';

/**
 * Verifies a GitHub webhook's `X-Hub-Signature-256` header against the payload.
 *
 * Kept dependency-free (no Octokit/Slack imports) so it is cheap to unit-test and
 * safe to reuse. Returns false — never throws — for empty, malformed, or
 * wrong-length signatures; the caller must reject when a secret is configured and
 * this returns false, including when the header is absent.
 */
export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const expectedSignatureWithPrefix = `sha256=${expectedSignature}`;

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignatureWithPrefix, 'utf8');

  // crypto.timingSafeEqual throws on length mismatch, so guard length first
  // (a malformed/short header would otherwise crash the handler with a 500).
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
