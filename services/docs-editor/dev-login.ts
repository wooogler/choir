import { buildSessionCookieHeader, issueSessionCookieValue } from './session-cookie';

/**
 * A development-only shortcut past Slack sign-in.
 *
 * Slack will not register an `http://localhost` redirect URL, so on a purely
 * local loop there is no way to obtain the session cookie the docs viewer needs.
 * This route mints one directly.
 *
 * It is a session-forgery endpoint. Four things gate it, and the first two are
 * the ones doing the work:
 *
 *  1. NODE_ENV must not be production.
 *  2. CHOIR_DEV_LOGIN must be exactly 'true' — opt in per process, never a default.
 *  3. CHOIR_DEV_TUNNEL_HOST must be unset. `pnpm dev:tunnel` exports it, so this
 *     route cannot be registered in a process whose ports are published to the
 *     internet.
 *  4. The requester must be on the loopback interface. This one is a backstop,
 *     not a fence: any reverse proxy in front of the app — including the Vite
 *     dev server that `pnpm dev:local` puts there — makes every request look
 *     local. Do not rely on it.
 *
 * The caller still has to name a workspace and user that already exist, which is
 * what `isKnownUser` is for. That is not a security property; it is there so a
 * typo produces an error rather than a session for a user who does not exist.
 */

type Router = { get: (path: string, handler: (req: Req, res: Res) => unknown) => void };
type Req = {
  query?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
};
type Res = {
  status: (code: number) => Res;
  send: (body: unknown) => Res;
  redirect: (url: string) => Res;
  setHeader: (name: string, value: string | string[]) => void;
};

export interface DevLoginDeps {
  cookieSecure: boolean;
  sanitizeNextPath: (next: string) => string;
  /** Injected so this module does not pull the Slack service graph into tests. */
  isKnownUser: (workspaceId: string, userId: string) => Promise<boolean>;
  logger: { warn: (message: string) => void };
}

const LOOPBACK = /^(::1|::ffff:127\.0\.0\.1|127\.\d+\.\d+\.\d+)$/;

/** Every condition under which the route may exist. All of them, or none. */
export function isDevLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.NODE_ENV || '').toLowerCase() !== 'production' && env.CHOIR_DEV_LOGIN === 'true' && !env.CHOIR_DEV_TUNNEL_HOST
  );
}

/** Registers nothing at all unless every gate in `isDevLoginEnabled` is open. */
export function registerDevLoginRoute(router: Router, deps: DevLoginDeps): boolean {
  if (!isDevLoginEnabled()) return false;

  router.get('/docs/auth/dev-login', async (req: Req, res: Res) => {
    const peer = req.socket?.remoteAddress || '';
    if (!LOOPBACK.test(peer)) {
      return res.status(403).send('dev-login is loopback only');
    }

    const workspaceId = String(req.query?.workspace || '').trim();
    const userId = String(req.query?.user || '').trim();
    if (!workspaceId || !userId) {
      return res.status(400).send('dev-login needs ?workspace=<id>&user=<id>');
    }

    if (!(await deps.isKnownUser(workspaceId, userId))) {
      return res.status(404).send(`No such workspace/user: ${workspaceId}/${userId}`);
    }

    const value = issueSessionCookieValue({ workspaceId, userId });
    res.setHeader('set-cookie', buildSessionCookieHeader(value, { secure: deps.cookieSecure }));
    deps.logger.warn(`dev-login issued a session for ${workspaceId}/${userId}`);

    const next = deps.sanitizeNextPath(String(req.query?.next || `/docs/${workspaceId}/README.md`));
    return res.redirect(next);
  });

  return true;
}
