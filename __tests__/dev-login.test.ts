import { isDevLoginEnabled, registerDevLoginRoute } from '../services/docs-editor/dev-login';
import { SESSION_COOKIE_NAME, verifySessionCookieValue } from '../services/docs-editor/session-cookie';

/**
 * dev-login mints a docs session without Slack. The point of these tests is the
 * gates: a regression that registers this route in production, or with the
 * tunnel up, hands anyone a manager session for any user.
 */

interface Captured {
  path: string;
  handler: (req: unknown, res: unknown) => Promise<unknown>;
}

function collectRoutes(isKnownUser = true) {
  const routes: Captured[] = [];
  const registered = registerDevLoginRoute(
    {
      get: (routePath: string, handler: Captured['handler']) => routes.push({ path: routePath, handler }),
    } as never,
    {
      cookieSecure: false,
      sanitizeNextPath: (next: string) => next,
      isKnownUser: async () => isKnownUser,
      logger: { warn: () => undefined },
    },
  );
  return { routes, registered };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string | string[]>,
    redirectedTo: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    redirect(url: string) {
      res.redirectedTo = url;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      res.headers[name] = value;
    },
  };
  return res;
}

const LOCAL_REQ = { socket: { remoteAddress: '127.0.0.1' } };

describe('dev-login gates', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('is off unless explicitly opted into', () => {
    expect(isDevLoginEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevLoginEnabled({ NODE_ENV: 'development', CHOIR_DEV_LOGIN: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevLoginEnabled({ NODE_ENV: 'development', CHOIR_DEV_LOGIN: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is off in production even when opted into', () => {
    expect(isDevLoginEnabled({ NODE_ENV: 'production', CHOIR_DEV_LOGIN: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevLoginEnabled({ NODE_ENV: 'PRODUCTION', CHOIR_DEV_LOGIN: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is off whenever a tunnel is publishing this process', () => {
    expect(
      isDevLoginEnabled({
        NODE_ENV: 'development',
        CHOIR_DEV_LOGIN: 'true',
        CHOIR_DEV_TUNNEL_HOST: 'example.ngrok-free.app',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('is on only with all gates open', () => {
    expect(isDevLoginEnabled({ NODE_ENV: 'development', CHOIR_DEV_LOGIN: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('registers no route at all when disabled', () => {
    process.env.NODE_ENV = 'development';
    Reflect.deleteProperty(process.env, 'CHOIR_DEV_LOGIN');
    const { routes, registered } = collectRoutes();
    expect(registered).toBe(false);
    expect(routes).toHaveLength(0);
  });
});

describe('dev-login route', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.CHOIR_DEV_LOGIN = 'true';
    Reflect.deleteProperty(process.env, 'CHOIR_DEV_TUNNEL_HOST');
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('mints a verifiable session and redirects', async () => {
    const { routes } = collectRoutes();
    const res = makeRes();
    await routes[0].handler({ ...LOCAL_REQ, query: { workspace: 'T1', user: 'U1', next: '/docs/T1/FAQ.md' } }, res);

    expect(res.redirectedTo).toBe('/docs/T1/FAQ.md');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).not.toContain('Secure');

    const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';')));
    const verified = verifySessionCookieValue(value);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.payload).toEqual({ workspaceId: 'T1', userId: 'U1' });
  });

  it('refuses a non-loopback caller', async () => {
    const { routes } = collectRoutes();
    const res = makeRes();
    await routes[0].handler({ socket: { remoteAddress: '10.0.0.4' }, query: { workspace: 'T1', user: 'U1' } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses an unknown user', async () => {
    const { routes } = collectRoutes(false);
    const res = makeRes();
    await routes[0].handler({ ...LOCAL_REQ, query: { workspace: 'T1', user: 'U-nope' } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('requires both a workspace and a user', async () => {
    const { routes } = collectRoutes();
    const res = makeRes();
    await routes[0].handler({ ...LOCAL_REQ, query: { workspace: 'T1' } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
