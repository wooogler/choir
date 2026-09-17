import { signImageToken, verifyImageToken } from '../services/docs-editor/image-token';

describe('image token (docs asset authorization)', () => {
  it('accepts a token for the exact workspace and path it was minted for', () => {
    const token = signImageToken('T123', 'assets/diagram.png');
    expect(verifyImageToken(token, 'T123', 'assets/diagram.png')).toBe(true);
  });

  it('rejects a token when the path differs (no cross-file access)', () => {
    const token = signImageToken('T123', 'assets/diagram.png');
    expect(verifyImageToken(token, 'T123', 'assets/secret.png')).toBe(false);
    expect(verifyImageToken(token, 'T123', 'README.md')).toBe(false);
  });

  it('rejects a token when the workspace differs (no cross-tenant access)', () => {
    const token = signImageToken('T123', 'assets/diagram.png');
    expect(verifyImageToken(token, 'T999', 'assets/diagram.png')).toBe(false);
  });

  it('rejects a malformed or empty token', () => {
    expect(verifyImageToken('not-a-real-token', 'T123', 'assets/diagram.png')).toBe(false);
    expect(verifyImageToken('', 'T123', 'assets/diagram.png')).toBe(false);
    expect(verifyImageToken('a.b', 'T123', 'assets/diagram.png')).toBe(false);
  });

  it('rejects a token whose payload was tampered with', () => {
    const token = signImageToken('T123', 'assets/diagram.png');
    const [payload, sig] = token.split('.');
    // Flip a character in the middle of the signature; verification must fail.
    // Do not touch the last character: a 32-byte HMAC encodes to 43 base64url
    // chars, so the final char's low bits are discarded padding and 'A' <-> 'B'
    // there can decode to the same bytes.
    const index = 3;
    const brokenSig = sig.slice(0, index) + (sig[index] === 'A' ? 'B' : 'A') + sig.slice(index + 1);
    expect(brokenSig).not.toBe(sig);
    expect(verifyImageToken(`${payload}.${brokenSig}`, 'T123', 'assets/diagram.png')).toBe(false);
  });

  it('rejects an already-expired token', () => {
    const token = signImageToken('T123', 'assets/diagram.png', -1000); // expired 1s ago
    expect(verifyImageToken(token, 'T123', 'assets/diagram.png')).toBe(false);
  });

  it('handles paths with non-ASCII characters', () => {
    const token = signImageToken('T123', 'assets/다이어그램.png');
    expect(verifyImageToken(token, 'T123', 'assets/다이어그램.png')).toBe(true);
    expect(verifyImageToken(token, 'T123', 'assets/other.png')).toBe(false);
  });
});
