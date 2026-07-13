import { redactSecrets, splitRemoteAuth } from '../services/workspace/git-mirror';

const TOKEN = 'ghp_ABCDEF1234567890abcdef';

describe('splitRemoteAuth (keep tokens out of .git/config)', () => {
  it('strips inline credentials from the persisted URL and moves them to a header arg', () => {
    const remote = `https://x-access-token:${TOKEN}@github.com/acme/docs.git`;
    const { cleanUrl, authArgs } = splitRemoteAuth(remote);

    // The URL that gets written to .git/config must not contain the token.
    expect(cleanUrl).toBe('https://github.com/acme/docs.git');
    expect(cleanUrl).not.toContain(TOKEN);

    // Auth is supplied per-invocation via an extraheader config.
    expect(authArgs[0]).toBe('-c');
    expect(authArgs[1]).toContain('http.https://github.com/.extraheader=AUTHORIZATION: basic ');
    // basic auth value is base64(user:token)
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(authArgs[1]).toContain(basic);
  });

  it('leaves a token-free URL untouched with no auth args', () => {
    const { cleanUrl, authArgs } = splitRemoteAuth('https://github.com/acme/docs.git');
    expect(cleanUrl).toBe('https://github.com/acme/docs.git');
    expect(authArgs).toEqual([]);
  });

  it('does not throw on an unparseable remote', () => {
    expect(() => splitRemoteAuth('not a url')).not.toThrow();
    expect(splitRemoteAuth('not a url')).toEqual({ cleanUrl: 'not a url', authArgs: [] });
  });
});

describe('redactSecrets (keep tokens out of logs)', () => {
  it('masks an x-access-token bearing URL', () => {
    const msg = `fatal: could not read from https://x-access-token:${TOKEN}@github.com/acme/docs.git`;
    const out = redactSecrets(msg);
    // Security contract: the token must be gone and the credentials masked, while
    // the (non-secret) host stays visible for debugging.
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('***@');
    expect(out).toContain('github.com/acme/docs.git');
  });

  it('masks an Authorization: basic header value', () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const msg = `command failed: git -c http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic} fetch`;
    const out = redactSecrets(msg);
    expect(out).not.toContain(basic);
    expect(out).toContain('AUTHORIZATION: basic ***');
  });

  it('masks generic user:password@ credentials in a URL', () => {
    const out = redactSecrets('https://alice:hunter2@example.com/repo.git');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('//***:***@');
  });

  it('leaves clean text unchanged', () => {
    const clean = 'fatal: repository not found';
    expect(redactSecrets(clean)).toBe(clean);
  });
});
