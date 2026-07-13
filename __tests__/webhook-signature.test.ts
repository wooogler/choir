import * as crypto from 'node:crypto';
import { verifyGitHubSignature } from '../services/github/verify-signature';

const SECRET = 'top-secret-webhook-key';

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('verifyGitHubSignature', () => {
  it('accepts a correctly computed signature', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    expect(verifyGitHubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature computed with a different secret', () => {
    const body = 'payload';
    expect(verifyGitHubSignature(body, sign(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a signature for a tampered body', () => {
    const original = JSON.stringify({ ref: 'refs/heads/main' });
    const tampered = JSON.stringify({ ref: 'refs/heads/evil' });
    expect(verifyGitHubSignature(tampered, sign(original), SECRET)).toBe(false);
  });

  it('returns false (does not throw) for an empty signature', () => {
    expect(() => verifyGitHubSignature('payload', '', SECRET)).not.toThrow();
    expect(verifyGitHubSignature('payload', '', SECRET)).toBe(false);
  });

  it('returns false (does not throw) for a short/malformed signature of a different length', () => {
    // Regression: crypto.timingSafeEqual throws on unequal buffer lengths, which
    // previously surfaced as a 500 instead of a clean rejection.
    expect(() => verifyGitHubSignature('payload', 'sha256=abc', SECRET)).not.toThrow();
    expect(verifyGitHubSignature('payload', 'sha256=abc', SECRET)).toBe(false);
  });

  it('returns false when the secret is empty', () => {
    expect(verifyGitHubSignature('payload', sign('payload'), '')).toBe(false);
  });

  it('rejects a valid-length signature with the wrong hex (same length, different value)', () => {
    const body = 'payload';
    const good = sign(body);
    const flipped = `sha256=${'0'.repeat(64)}`;
    expect(flipped.length).toBe(good.length);
    expect(verifyGitHubSignature(body, flipped, SECRET)).toBe(false);
  });
});
