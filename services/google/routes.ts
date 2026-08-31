import { AppConfig } from '@/config';
import { OAUTH_NONCE_COOKIE, issueOAuthState, verifyOAuthState } from 'services/docs-editor/oauth-state';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { getDocMeta } from './drive-client';
import { getAllDocStates, removeDocState } from './gdocs-state';
import {
  GoogleNotConfiguredError,
  buildAuthUrl,
  disconnectWorkspace,
  exchangeCodeForCredential,
  getWorkspaceClient,
} from './google-auth-service';
import { issuePickerNonce, verifyPickerNonce } from './picker-nonce';
import { publishReplica } from './replica-publisher';

/**
 * HTTP surface for connecting a workspace's Google account and linking documents
 * to their replicas.
 *
 * Registered from app.ts, which owns session reading and the cookie policy, so
 * those arrive as dependencies rather than being re-implemented here.
 *
 * IMPORTANT: these must be registered before `/api/docs/:workspaceId/*splat`,
 * which would otherwise swallow every `/api/docs/<id>/google/...` path.
 */

export interface GoogleRouteDeps {
  readSession: (req: unknown) => Promise<{ workspaceId: string; userId: string } | null>;
  isManager: (workspaceId: string, userId: string) => Promise<boolean>;
  cookieSecure: boolean;
  jsonBody: unknown;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
  sanitizeNextPath: (next: string) => string;
}

const NONCE_COOKIE_PATH = '/docs/auth/google';

// Express's router and handlers are untyped throughout app.ts (the receiver
// exposes them as `any`); these aliases keep that contained to one place.
type Router = { get: Handler; post: Handler; delete: Handler };
type Handler = (path: string, ...rest: unknown[]) => void;
type Req = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};
type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => Res;
  send: (body: unknown) => Res;
  redirect: (url: string) => Res;
  setHeader: (name: string, value: string | string[]) => void;
};

export function registerGoogleDriveRoutes(router: Router, deps: GoogleRouteDeps): void {
  const store = new WorkspaceStore();

  /**
   * Every route is bound to the session's own workspace. Reading the workspace
   * from the URL alone would let one workspace's manager mint another
   * workspace's Google token.
   */
  const requireManagerOf = async (req: Req, res: Res, workspaceId: string) => {
    const session = await deps.readSession(req);
    if (!session || session.workspaceId !== workspaceId) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    if (!(await deps.isManager(workspaceId, session.userId))) {
      res.status(403).json({ error: 'Manager access required' });
      return null;
    }
    return session;
  };

  // ── Connect a Google account (one per workspace) ──────────────────────────

  router.get('/docs/auth/google/start', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.query?.workspaceId || '').trim();
      if (!workspaceId) {
        return res.status(400).send('Missing workspaceId');
      }
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      const next = deps.sanitizeNextPath(String(req.query?.next || '/'));
      const { state, nonce } = issueOAuthState({ workspaceId, next });

      // Binds the flow to this browser, exactly as the Slack sign-in does.
      res.setHeader(
        'set-cookie',
        `${OAUTH_NONCE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=${NONCE_COOKIE_PATH}; Max-Age=600${
          deps.cookieSecure ? '; Secure' : ''
        }`,
      );
      return res.redirect(buildAuthUrl(state));
    } catch (err) {
      if (err instanceof GoogleNotConfiguredError) {
        return res.status(503).send('Google Drive sync is not configured on this server.');
      }
      deps.logger.error('Google OAuth start failed', err);
      return res.status(500).send('Could not start the Google connection');
    }
  });

  router.get('/docs/auth/google/callback', async (req: Req, res: Res) => {
    try {
      const code = String(req.query?.code || '').trim();
      const stateRaw = String(req.query?.state || '').trim();
      if (!code || !stateRaw) {
        return res.status(400).send('Missing code or state');
      }

      const state = verifyOAuthState(stateRaw);
      if (!state.ok) {
        return res.status(400).send(`Invalid state (${state.reason})`);
      }

      const nonceCookie = /(?:^|;\s*)choir_oauth_nonce=([^;]+)/.exec(req.headers?.cookie || '')?.[1];
      if (!nonceCookie || nonceCookie !== state.payload.nonce) {
        return res.status(400).send('Invalid state (nonce mismatch)');
      }

      // Re-check authorization at the callback: the session may have changed, or
      // the manager may have been demoted, since /start issued the state.
      const session = await requireManagerOf(req, res, state.payload.workspaceId);
      if (!session) {
        return undefined;
      }

      const credential = await exchangeCodeForCredential(code);
      await store.setGoogleAuth(state.payload.workspaceId, {
        refreshToken: credential.refreshToken,
        email: credential.email,
        connectedBy: session.userId,
      });

      res.setHeader(
        'set-cookie',
        `${OAUTH_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=${NONCE_COOKIE_PATH}; Max-Age=0${
          deps.cookieSecure ? '; Secure' : ''
        }`,
      );
      return res.redirect(deps.sanitizeNextPath(state.payload.next));
    } catch (err) {
      deps.logger.error('Google OAuth callback failed', err);
      return res.status(500).send('Could not complete the Google connection');
    }
  });

  // ── Status, picker bootstrap, link/unlink ────────────────────────────────

  router.get('/api/docs/:workspaceId/google/status', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await deps.readSession(req);
      if (!session || session.workspaceId !== workspaceId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { configured } = AppConfig.getGoogleConfig();
      const auth = await store.getGoogleAuth(workspaceId);
      const mappings = await store.getGoogleDocMappings(workspaceId);
      const states = await getAllDocStates(workspaceId);

      const filePath = typeof req.query?.filePath === 'string' ? req.query.filePath : undefined;
      const mapping = filePath ? mappings[filePath] : undefined;

      return res.json({
        configured,
        connected: Boolean(auth),
        email: auth?.email,
        broken: Boolean(auth?.broken),
        document: mapping
          ? {
              fileId: mapping.fileId,
              webViewLink: mapping.webViewLink,
              linkedAt: mapping.linkedAt,
              status: filePath ? (states[filePath]?.status ?? 'synced') : undefined,
            }
          : null,
        linkedCount: Object.keys(mappings).length,
      });
    } catch (err) {
      deps.logger.error('GET google/status failed', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * Hands the browser a short-lived access token for the Picker, plus the nonce
   * that a subsequent link must present. The token is the workspace account's,
   * so it is minted per request and never persisted client-side.
   */
  router.post('/api/docs/:workspaceId/google/picker-token', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await requireManagerOf(req, res, workspaceId);
      if (!session) {
        return undefined;
      }

      const { pickerApiKey, projectNumber } = AppConfig.getGoogleConfig();
      if (!pickerApiKey || !projectNumber) {
        return res.status(503).json({
          error: 'The file picker is not configured (GOOGLE_PICKER_API_KEY, GOOGLE_PROJECT_NUMBER)',
        });
      }

      const client = await getWorkspaceClient(workspaceId);
      if (!client) {
        return res.status(409).json({ error: 'Connect a Google account first' });
      }

      const token = await client.getAccessToken();
      if (!token.token) {
        return res.status(502).json({ error: 'Google did not return an access token' });
      }

      return res.json({
        accessToken: token.token,
        apiKey: pickerApiKey,
        // The Picker's appId must be the project number of the same Cloud project
        // as the OAuth client, or the per-file grant never attaches to this app.
        appId: projectNumber,
        pickerNonce: issuePickerNonce(workspaceId, session.userId),
      });
    } catch (err) {
      deps.logger.error('POST google/picker-token failed', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/docs/:workspaceId/google/link', deps.jsonBody, async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await requireManagerOf(req, res, workspaceId);
      if (!session) {
        return undefined;
      }

      const filePath = String(req.body?.filePath || '').trim();
      const fileId = String(req.body?.fileId || '').trim();
      const pickerNonce = String(req.body?.pickerNonce || '');

      if (!filePath || !fileId) {
        return res.status(400).json({ error: 'filePath and fileId are required' });
      }
      // Linking replaces the document's content, so it must follow a deliberate
      // pick rather than an arbitrary fileId posted at the endpoint.
      if (!verifyPickerNonce(pickerNonce, workspaceId, session.userId)) {
        return res.status(400).json({ error: 'Pick the document again — this link request has expired' });
      }

      const markdown = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, filePath);
      if (markdown === null) {
        return res.status(404).json({ error: 'No such document in this workspace' });
      }

      const client = await getWorkspaceClient(workspaceId);
      if (!client) {
        return res.status(409).json({ error: 'Connect a Google account first' });
      }

      // Confirms the grant actually reaches this file before anything is stored.
      const meta = await getDocMeta(client, fileId);
      if (meta.trashed) {
        return res.status(400).json({ error: 'That document is in the trash' });
      }

      await store.setGoogleDocMapping(workspaceId, filePath, {
        fileId,
        webViewLink: meta.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
        linkedBy: session.userId,
      });

      // Force: a freshly linked document has no recorded hash or state, but the
      // Doc's existing content must be replaced now rather than at some later
      // GitHub change.
      const published = await publishReplica({ workspaceId, githubPath: filePath, markdown, force: true });
      deps.logger.info('Linked a GitHub document to a Google Doc', { workspaceId, filePath, fileId });

      return res.json({
        ok: true,
        fileId,
        webViewLink: meta.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
        published: published.outcome,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      // A duplicate fileId is the caller's mistake, not a server fault.
      if (/already linked to/.test(message)) {
        return res.status(409).json({ error: message });
      }
      deps.logger.error('POST google/link failed', err);
      return res.status(500).json({ error: message });
    }
  });

  router.delete('/api/docs/:workspaceId/google/link', deps.jsonBody, async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      const filePath = String(req.body?.filePath || req.query?.filePath || '').trim();
      if (!filePath) {
        return res.status(400).json({ error: 'filePath is required' });
      }

      const removed = await store.removeGoogleDocMapping(workspaceId, filePath);
      // Drop the bookkeeping too: a stale baseline would be compared against a
      // different document if this path is ever linked again.
      await removeDocState(workspaceId, filePath);

      return res.json({ ok: true, removed });
    } catch (err) {
      deps.logger.error('DELETE google/link failed', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/docs/:workspaceId/google/disconnect', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      await disconnectWorkspace(workspaceId);
      deps.logger.info('Disconnected the workspace Google account', { workspaceId });
      // Mappings survive on purpose: reconnecting the same account restores every
      // replica without re-picking each document.
      return res.json({ ok: true });
    } catch (err) {
      deps.logger.error('POST google/disconnect failed', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
