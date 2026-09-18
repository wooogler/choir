import {
  INSTALL_GATE_COOKIE_NAME,
  buildInstallGateCookieHeader,
  clearAttempts,
  clientKeyFromRequest,
  hasValidInstallTicket,
  isInstallGateEnabled,
  issueInstallGateCookieValue,
  registerAttempt,
  renderInstallPasscodePage,
  resetAttemptsForTest,
  verifyPasscode,
} from '../services/slack/install-gate';

/**
 * The gate keeps an invite-only deployment from being installed by anyone who
 * finds /slack/install. What matters here is that it cannot be bypassed with a
 * forged cookie, that rotating the passcode invalidates outstanding tickets,
 * and that it disappears entirely when unconfigured.
 */

const ORIGINAL_PASSCODE = process.env.INSTALL_PASSCODE;

function cookieHeaderFor(value: string): string {
  return `${INSTALL_GATE_COOKIE_NAME}=${encodeURIComponent(value)}`;
}

afterEach(() => {
  // Empty rather than deleted: the gate treats a blank value as unconfigured,
  // and this is how the rest of the suite restores env vars.
  process.env.INSTALL_PASSCODE = ORIGINAL_PASSCODE ?? '';
  resetAttemptsForTest();
});

describe('install gate configuration', () => {
  it('stays dormant when no passcode is configured', () => {
    process.env.INSTALL_PASSCODE = '';
    expect(isInstallGateEnabled()).toBe(false);
    expect(verifyPasscode('echo')).toBe(false);
    expect(hasValidInstallTicket('anything=1')).toBe(false);
  });

  it('treats a blank passcode as unconfigured rather than as an empty secret', () => {
    process.env.INSTALL_PASSCODE = '   ';
    expect(isInstallGateEnabled()).toBe(false);
    expect(verifyPasscode('')).toBe(false);
  });
});

describe('passcode verification', () => {
  beforeEach(() => {
    process.env.INSTALL_PASSCODE = 'echo';
  });

  it('accepts the configured passcode regardless of surrounding space or case', () => {
    expect(verifyPasscode('echo')).toBe(true);
    expect(verifyPasscode(' echo ')).toBe(true);
    expect(verifyPasscode('Echo')).toBe(true);
  });

  it('rejects anything else, including non-strings', () => {
    expect(verifyPasscode('ech')).toBe(false);
    expect(verifyPasscode('echo1')).toBe(false);
    expect(verifyPasscode('')).toBe(false);
    expect(verifyPasscode(undefined)).toBe(false);
    expect(verifyPasscode({ toString: () => 'echo' })).toBe(false);
  });
});

describe('install tickets', () => {
  beforeEach(() => {
    process.env.INSTALL_PASSCODE = 'echo';
  });

  it('admits a request carrying a ticket this deployment issued', () => {
    const cookie = cookieHeaderFor(issueInstallGateCookieValue());
    expect(hasValidInstallTicket(cookie)).toBe(true);
  });

  it('refuses a forged or tampered ticket', () => {
    expect(hasValidInstallTicket(cookieHeaderFor('not-a-ticket'))).toBe(false);
    const real = issueInstallGateCookieValue();
    const tampered = `${real.split('.')[0]}.AAAA`;
    expect(hasValidInstallTicket(cookieHeaderFor(tampered))).toBe(false);
  });

  it('invalidates outstanding tickets when the passcode is rotated', () => {
    const cookie = cookieHeaderFor(issueInstallGateCookieValue());
    process.env.INSTALL_PASSCODE = 'foxtrot';
    expect(hasValidInstallTicket(cookie)).toBe(false);
  });

  it('ignores unrelated cookies on the same request', () => {
    const cookie = `choir_docs_session=abc; ${cookieHeaderFor(issueInstallGateCookieValue())}; other=1`;
    expect(hasValidInstallTicket(cookie)).toBe(true);
    expect(hasValidInstallTicket('choir_docs_session=abc; other=1')).toBe(false);
  });

  it('scopes the cookie to the install path and keeps it out of scripts', () => {
    const header = buildInstallGateCookieHeader('value', { secure: true });
    expect(header).toContain('Path=/slack/install');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(buildInstallGateCookieHeader('value', { secure: false })).not.toContain('Secure');
  });
});

describe('attempt throttling', () => {
  it('allows ten attempts per key and then refuses', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(registerAttempt('1.2.3.4').allowed).toBe(true);
    }
    expect(registerAttempt('1.2.3.4').allowed).toBe(false);
  });

  it('counts each client separately so one guesser cannot lock out the rest', () => {
    for (let i = 0; i < 11; i += 1) registerAttempt('1.2.3.4');
    expect(registerAttempt('5.6.7.8').allowed).toBe(true);
  });

  it('forgets attempts once the window passes, and on success', () => {
    const start = Date.now();
    for (let i = 0; i < 11; i += 1) registerAttempt('1.2.3.4', start);
    expect(registerAttempt('1.2.3.4', start + 16 * 60 * 1000).allowed).toBe(true);

    for (let i = 0; i < 11; i += 1) registerAttempt('9.9.9.9');
    clearAttempts('9.9.9.9');
    expect(registerAttempt('9.9.9.9').allowed).toBe(true);
  });
});

describe('client key', () => {
  it('prefers the forwarded address, since every socket behind nginx is loopback', () => {
    expect(clientKeyFromRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, '127.0.0.1')).toBe('203.0.113.7');
  });

  it('falls back to the socket address when there is no proxy header', () => {
    expect(clientKeyFromRequest({}, '203.0.113.9')).toBe('203.0.113.9');
    expect(clientKeyFromRequest(undefined, undefined)).toBe('unknown');
  });
});

describe('passcode page', () => {
  it('posts to the given action and escapes what it renders', () => {
    const html = renderInstallPasscodePage({ action: '/slack/install/passcode' });
    expect(html).toContain('action="/slack/install/passcode"');
    expect(html).toContain('name="passcode"');
    expect(html).toContain('noindex');

    const withError = renderInstallPasscodePage({
      action: '/slack/install/passcode',
      error: '<img src=x onerror="alert(1)">',
    });
    expect(withError).not.toContain('<img src=x');
    expect(withError).toContain('&lt;img src=x');
  });

  it('shows no error block when there is no error', () => {
    expect(renderInstallPasscodePage({ action: '/x' })).not.toContain('role="alert"');
  });
});
