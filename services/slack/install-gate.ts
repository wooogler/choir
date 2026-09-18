/**
 * Passcode gate for the Slack install path.
 *
 * The hosted deployment is not open to the public yet: anyone who finds
 * `/slack/install` could otherwise add CHOIR to their own workspace. This
 * module guards that path with a shared passcode handed out to invited teams.
 *
 * It is a speed bump, not an authorization system. The passcode is shared and
 * unversioned, so it keeps strangers out while the study is invite-only; it is
 * not a substitute for Slack's own install consent. Self-hosted deployments
 * leave `INSTALL_PASSCODE` unset and the gate stays dormant.
 */
import crypto from 'node:crypto';
import { signPayload, verifyPayload } from 'services/docs-editor/signed-payload';

export const INSTALL_GATE_COOKIE_NAME = 'choir_install_gate';
export const INSTALL_GATE_COOKIE_PATH = '/slack/install';
export const INSTALL_GATE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Attempts allowed per client address before the gate stops answering. */
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface GateTicket {
  /** Fingerprint of the passcode the ticket was issued for. */
  fp: string;
}

export function getInstallPasscode(): string | undefined {
  const configured = process.env.INSTALL_PASSCODE;
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isInstallGateEnabled(): boolean {
  return getInstallPasscode() !== undefined;
}

/**
 * Normalized so a phone keyboard that capitalizes the first letter does not
 * lock out an invited team. The passcode is short and shared out of band, so
 * case sensitivity buys no real secrecy.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function fingerprint(passcode: string): string {
  return crypto
    .createHash('sha256')
    .update(`install-gate:${normalize(passcode)}`)
    .digest('hex')
    .slice(0, 16);
}

export function verifyPasscode(input: unknown): boolean {
  const expected = getInstallPasscode();
  if (!expected) return false;
  if (typeof input !== 'string') return false;

  const provided = Buffer.from(normalize(input), 'utf-8');
  const target = Buffer.from(normalize(expected), 'utf-8');
  // crypto.timingSafeEqual throws on length mismatch, so guard length first.
  if (provided.length !== target.length) return false;
  return crypto.timingSafeEqual(provided, target);
}

export function issueInstallGateCookieValue(): string {
  const passcode = getInstallPasscode();
  if (!passcode) throw new Error('Install gate is not configured');
  return signPayload<GateTicket>('install-gate', { fp: fingerprint(passcode) }, INSTALL_GATE_TTL_MS);
}

export function buildInstallGateCookieHeader(value: string, options?: { secure?: boolean }): string {
  const parts = [
    `${INSTALL_GATE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${INSTALL_GATE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(INSTALL_GATE_TTL_MS / 1000)}`,
  ];
  if (options?.secure !== false) parts.push('Secure');
  return parts.join('; ');
}

function readGateCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const cookie of cookieHeader.split(';')) {
    const eqIndex = cookie.indexOf('=');
    if (eqIndex < 0) continue;
    if (cookie.slice(0, eqIndex).trim() !== INSTALL_GATE_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(cookie.slice(eqIndex + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True when the request carries a ticket this deployment issued for the
 * passcode currently in force. Rotating `INSTALL_PASSCODE` invalidates every
 * outstanding ticket, because the fingerprint no longer matches.
 */
export function hasValidInstallTicket(cookieHeader: string | undefined | null): boolean {
  const passcode = getInstallPasscode();
  if (!passcode) return false;

  const raw = readGateCookie(cookieHeader);
  if (!raw) return false;

  const result = verifyPayload<GateTicket>('install-gate', raw);
  if (!result.ok) return false;
  return result.payload?.fp === fingerprint(passcode);
}

const attempts = new Map<string, { count: number; firstAt: number }>();

/**
 * Coarse per-address throttle. In-memory on purpose: a restart clearing it is
 * acceptable for a gate this soft, and it keeps the deployment free of another
 * storage dependency.
 */
export function registerAttempt(clientKey: string, now: number = Date.now()): { allowed: boolean } {
  const key = clientKey || 'unknown';
  const existing = attempts.get(key);

  if (!existing || now - existing.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return { allowed: true };
  }

  existing.count += 1;
  return { allowed: existing.count <= MAX_ATTEMPTS };
}

export function clearAttempts(clientKey: string): void {
  attempts.delete(clientKey || 'unknown');
}

/** Test seam: drops the throttle state between cases. */
export function resetAttemptsForTest(): void {
  attempts.clear();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PasscodePageOptions {
  /** Where the form posts. */
  action: string;
  /** Shown above the field when a previous attempt failed. */
  error?: string;
}

export function renderInstallPasscodePage(options: PasscodePageOptions): string {
  const errorBlock = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>CHOIR · Installation passcode</title>
    <link rel="stylesheet" href="/assets/site.css" />
    <style>
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 24px;
        background: var(--surface-alt, #f5f7fb);
      }
      .gate {
        width: 100%;
        max-width: 420px;
        padding: 36px 32px;
        background: var(--surface, #fff);
        border: 1px solid var(--line, #d8dee9);
        border-radius: 14px;
        box-shadow: var(--shadow, 0 20px 60px rgba(24, 32, 51, 0.12));
      }
      .gate h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      .gate p {
        margin: 0 0 24px;
        color: var(--muted, #5b6475);
        line-height: 1.55;
      }
      .gate label {
        display: block;
        margin-bottom: 8px;
        font-weight: 650;
        font-size: 14px;
      }
      .gate input {
        width: 100%;
        min-height: 48px;
        margin-bottom: 16px;
        padding: 0 14px;
        font: inherit;
        color: var(--ink, #182033);
        background: #fff;
        border: 1px solid var(--line, #d8dee9);
        border-radius: 8px;
      }
      .gate input:focus {
        outline: 2px solid var(--blue, #2357c5);
        outline-offset: 1px;
      }
      .gate .button {
        width: 100%;
        justify-content: center;
        cursor: pointer;
      }
      .gate .error {
        margin: 0 0 16px;
        padding: 12px 14px;
        color: var(--coral, #cc5a43);
        background: rgba(204, 90, 67, 0.08);
        border: 1px solid rgba(204, 90, 67, 0.35);
        border-radius: 8px;
        font-size: 14px;
      }
      .gate .back {
        display: block;
        margin-top: 20px;
        color: var(--muted, #5b6475);
        font-size: 14px;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <main class="gate">
      <h1>Installation passcode</h1>
      <p>CHOIR is in invite-only testing. Enter the passcode you were given to continue to Slack.</p>
      ${errorBlock}
      <form method="post" action="${escapeHtml(options.action)}">
        <label for="passcode">Passcode</label>
        <input
          id="passcode"
          name="passcode"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          required
          autofocus
        />
        <button class="button primary" type="submit">Continue to Slack</button>
      </form>
      <a class="back" href="/">Back to choir</a>
    </main>
  </body>
</html>`;
}

/**
 * Throttle key for a request. Prefers the forwarded address because the hosted
 * deployment sits behind nginx, where every socket address is the loopback one
 * and a shared key would let one wrong guess lock out every other visitor.
 * A spoofed header only evades the throttle, which is no worse than not having
 * one.
 */
export function clientKeyFromRequest(headers: Record<string, unknown> | undefined, remoteAddress?: string): string {
  const forwarded = headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === 'string' && raw.trim()) {
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress || 'unknown';
}
