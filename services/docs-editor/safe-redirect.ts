/**
 * Sanitizes a post-login `next` redirect target so it can only ever point back
 * to this origin. A bare `startsWith('/')` check is not enough: browsers treat
 * `//evil.com` (protocol-relative) and `/\evil.com` (backslash) as absolute
 * off-site URLs, which turns the OIDC flow into an open redirect. Anything that
 * is not a plain same-origin absolute path collapses to `/`.
 */
export function sanitizeNextPath(next: string | undefined | null): string {
  if (typeof next !== 'string') return '/';
  if (next.startsWith('/') && next[1] !== '/' && next[1] !== '\\') {
    return next;
  }
  return '/';
}
