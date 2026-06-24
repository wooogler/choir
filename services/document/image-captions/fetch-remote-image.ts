import dns from 'node:dns/promises';
import net from 'node:net';
import { Logger } from 'services/common/logger';

const MAX_REMOTE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface RemoteImage {
  bytes: Buffer;
  contentType: string;
}

/** Rejects loopback, private, link-local (incl. cloud metadata), and CGNAT ranges. */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unknown format → treat as unsafe
}

/**
 * Best-effort fetch of a remote image for captioning, with a basic SSRF guard
 * (blocks private/loopback/link-local targets), a timeout, a size cap, and a
 * content-type allowlist. Returns null on any failure — callers must degrade to
 * alt-text-only indexing rather than treating this as fatal.
 *
 * Note: the DNS check is TOCTOU-racy (rebinding); acceptable for the current
 * threat model (manager-connected docs repos), not a hardened egress proxy.
 */
/**
 * Validates that a URL is http(s) and resolves to a public address (SSRF guard).
 * Returns the parsed URL when safe, or null. Shared by the image and link-content
 * fetchers. Note: the DNS check is TOCTOU-racy (rebinding) — acceptable for the
 * current threat model (manager-connected docs), not a hardened egress proxy.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  try {
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      Logger.warn('assertPublicUrl: blocked non-public host', { host: url.hostname });
      return null;
    }
  } catch {
    return null;
  }

  return url;
}

export async function fetchRemoteImage(rawUrl: string): Promise<RemoteImage | null> {
  const url = await assertPublicUrl(rawUrl);
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'image/*' },
    });
    if (!response.ok) return null;

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) return null;

    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength && declaredLength > MAX_REMOTE_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_REMOTE_BYTES) return null;

    return { bytes, contentType };
  } catch (error) {
    Logger.info('fetchRemoteImage: fetch failed, indexing alt text only', {
      url: rawUrl,
      error: (error as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
