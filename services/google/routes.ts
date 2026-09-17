import { AppConfig } from '@/config';
import { type DocsApiErrorCode, apiError, apiErrorBodyFor } from 'services/docs-editor/api-errors';
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
import { importGoogleDoc } from './import-service';
import type { ImportProgress } from './import-steps';
import { retireAllManualCards, retireManualCards } from './manual-apply';
import { issuePickerNonce, verifyPickerNonce } from './picker-nonce';
import { publishReplica } from './replica-publisher';
import { retireAllReviewCards, retireReviewCards } from './review-cards';
import { approveReview, buildReview, rejectReview } from './review-service';

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
  /** Used to retire review cards whose decision is no longer possible. */
  slackClient?: import('@slack/web-api').WebClient;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
  sanitizeNextPath: (next: string) => string;
}

const NONCE_COOKIE_PATH = '/docs/auth/google';

/** Content type the import endpoint streams step-by-step progress as. */
const IMPORT_STREAM_TYPE = 'application/x-ndjson';

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
  /** Used by the streaming import, which reports progress line by line. */
  write: (chunk: string) => boolean;
  end: (chunk?: string) => void;
  flushHeaders?: () => void;
  headersSent?: boolean;
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
      apiError(res, 401, 'unauthorized');
      return null;
    }
    if (!(await deps.isManager(workspaceId, session.userId))) {
      apiError(res, 403, 'manager_access_required');
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
        return apiError(res, 401, 'unauthorized');
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
              mode: mapping.mode,
              // A preserved document cannot receive a GitHub change on its own,
              // so the viewer has to be able to say that one is waiting rather
              // than showing a document that looks in sync and is not.
              awaitingManualApply: Boolean(
                filePath && states[filePath]?.pendingManual && !states[filePath]?.pendingManual?.declined,
              ),
            }
          : null,
        linkedCount: Object.keys(mappings).length,
      });
    } catch (err) {
      deps.logger.error('GET google/status failed', err);
      return apiError(res, 500, 'internal_error');
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
        return apiError(res, 503, 'google_picker_not_configured');
      }

      const client = await getWorkspaceClient(workspaceId);
      if (!client) {
        return apiError(res, 409, 'google_not_connected');
      }

      const token = await client.getAccessToken();
      if (!token.token) {
        return apiError(res, 502, 'google_no_access_token');
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
      return apiError(res, 500, 'internal_error');
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
        return apiError(res, 400, 'file_path_and_file_id_required');
      }
      // Linking replaces the document's content, so it must follow a deliberate
      // pick rather than an arbitrary fileId posted at the endpoint.
      if (!verifyPickerNonce(pickerNonce, workspaceId, session.userId)) {
        return apiError(res, 400, 'google_pick_expired_link');
      }

      const markdown = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, filePath);
      if (markdown === null) {
        return apiError(res, 404, 'google_doc_missing_in_repo');
      }

      const client = await getWorkspaceClient(workspaceId);
      if (!client) {
        return apiError(res, 409, 'google_not_connected');
      }

      // Confirms the grant actually reaches this file before anything is stored.
      const meta = await getDocMeta(client, fileId);
      if (meta.trashed) {
        return apiError(res, 400, 'google_doc_trashed');
      }

      await store.setGoogleDocMapping(workspaceId, filePath, {
        fileId,
        webViewLink: meta.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
        linkedBy: session.userId,
        // Linking publishes the repository document over whatever the picked Doc
        // held, which the caller has just been warned about and agreed to. That
        // is `replica` by definition. Bringing an already-written Doc in without
        // flattening it is the *import* route, which links as `preserve`.
        mode: 'replica',
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
      // A duplicate fileId is the caller's mistake, not a server fault. The
      // store phrases it as a sentence; the conflicting path is the half of it
      // the manager needs, so it travels as a detail the viewer can re-word.
      const conflict = /already linked to (.+)$/.exec(message);
      if (conflict) {
        return apiError(res, 409, 'google_doc_already_linked', {
          fileId: String(req.body?.fileId || '').trim(),
          conflictPath: conflict[1],
        });
      }
      deps.logger.error('POST google/link failed', err);
      return apiError(res, 500, 'internal_error', { message });
    }
  });

  /**
   * Brings a Google Doc into the repository as a new document, then links it.
   *
   * The picker nonce is required for the same reason as linking: this writes a
   * commit from a fileId the caller supplies, so it must follow a deliberate
   * pick rather than an arbitrary id posted at the endpoint.
   */
  router.post('/api/docs/:workspaceId/google/import', deps.jsonBody, async (req: Req, res: Res) => {
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
        return apiError(res, 400, 'file_path_and_file_id_required');
      }
      if (!verifyPickerNonce(pickerNonce, workspaceId, session.userId)) {
        return apiError(res, 400, 'google_pick_expired_import');
      }

      // An import runs long enough to need a progress bar: reading the Doc,
      // committing it with its images, and writing the replica back are each
      // several seconds. A client that asks for NDJSON gets one line per step
      // and a final `result` line; everyone else gets the single JSON body the
      // endpoint has always returned.
      const streaming = String(req.headers?.accept || '').includes(IMPORT_STREAM_TYPE);
      if (streaming) {
        res.setHeader('Content-Type', `${IMPORT_STREAM_TYPE}; charset=utf-8`);
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        // Progress arrives in pieces; a proxy holding it back to buffer the
        // whole body would defeat the point.
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
      }

      const onProgress = streaming
        ? (progress: ImportProgress) => {
            res.write(`${JSON.stringify({ type: 'progress', ...progress })}\n`);
          }
        : undefined;

      const result = await importGoogleDoc({
        workspaceId,
        githubPath: filePath,
        fileId,
        userId: session.userId,
        onProgress,
      });

      if (result.outcome === 'imported') {
        deps.logger.info('Imported a Google Doc into the repository', {
          workspaceId,
          filePath: result.githubPath,
          fileId,
        });
        if (streaming) {
          return res.end(`${JSON.stringify({ type: 'result', ...result })}\n`);
        }
        return res.json(result);
      }

      const status =
        result.outcome === 'exists'
          ? 409
          : result.outcome === 'not-connected'
            ? 409
            : result.outcome === 'invalid-path' || result.outcome === 'empty'
              ? 400
              : 500;
      // `outcome` is already a code, but it is the import service's vocabulary
      // rather than the API's, so it is translated into one the viewer's
      // catalog covers and kept alongside for anyone who reads it today.
      const body = { ...importErrorBody(result, filePath), code: result.outcome };
      // The status line is long gone once progress has been streamed, so a
      // streaming caller reads the outcome off the final line instead.
      if (streaming) {
        return res.end(`${JSON.stringify({ type: 'error', ...body, status })}\n`);
      }
      return res.status(status).json(body);
    } catch (err) {
      deps.logger.error('POST google/import failed', err);
      if (res.headersSent) {
        return res.end(`${JSON.stringify({ type: 'error', ...apiErrorBodyFor('internal_error'), status: 500 })}\n`);
      }
      return apiError(res, 500, 'internal_error');
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
        return apiError(res, 400, 'file_path_required');
      }

      // Retire cards before the mapping goes: a manager clicking Approve on a
      // card for an unlinked document would act against a mapping that no
      // longer exists.
      await retireReviewCards({
        workspaceId,
        githubPath: filePath,
        notice: { reason: 'gdocs.card.retired.unlinkedReview' },
        client: deps.slackClient,
      });
      await retireManualCards({
        workspaceId,
        githubPath: filePath,
        notice: { reason: 'gdocs.card.retired.unlinkedManual' },
        client: deps.slackClient,
      });

      const removed = await store.removeGoogleDocMapping(workspaceId, filePath);
      // Drop the bookkeeping too: a stale baseline would be compared against a
      // different document if this path is ever linked again.
      await removeDocState(workspaceId, filePath);

      return res.json({ ok: true, removed });
    } catch (err) {
      deps.logger.error('DELETE google/link failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  // ── Review an edit made in Google Docs ───────────────────────────────────

  router.get('/api/docs/:workspaceId/google/review', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      const filePath = typeof req.query?.filePath === 'string' ? req.query.filePath : '';
      if (!filePath) {
        return apiError(res, 400, 'file_path_required');
      }

      return res.json(await buildReview(workspaceId, filePath));
    } catch (err) {
      deps.logger.error('GET google/review failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  router.post('/api/docs/:workspaceId/google/review/approve', deps.jsonBody, async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const session = await requireManagerOf(req, res, workspaceId);
      if (!session) {
        return undefined;
      }

      const filePath = String(req.body?.filePath || '').trim();
      const content = typeof req.body?.content === 'string' ? req.body.content : null;
      if (!filePath || content === null) {
        return apiError(res, 400, 'file_path_and_content_required');
      }

      const result = await approveReview({ workspaceId, githubPath: filePath, userId: session.userId, content });
      // 409 for the fences: the manager decided against a state that has moved,
      // and the client should re-read the rebuilt review rather than retry.
      const status =
        result.outcome === 'committed'
          ? 200
          : // The commit landed; the replica did not. Report it as a server-side
            // problem so the manager is told, not as a refused fence.
            result.outcome === 'failed' || result.outcome === 'committed-not-republished'
            ? 500
            : 409;
      return res.status(status).json(result);
    } catch (err) {
      deps.logger.error('POST google/review/approve failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  router.post('/api/docs/:workspaceId/google/review/reject', deps.jsonBody, async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      const filePath = String(req.body?.filePath || '').trim();
      if (!filePath) {
        return apiError(res, 400, 'file_path_required');
      }

      const result = await rejectReview(workspaceId, filePath);
      // 'declined-not-restored' is a preserve-mode success: the decision stuck,
      // but reverting the document is a person's job.
      const status =
        result.outcome === 'restored' || result.outcome === 'declined-not-restored'
          ? 200
          : result.outcome === 'failed'
            ? 500
            : 409;
      return res.status(status).json(result);
    } catch (err) {
      deps.logger.error('POST google/review/reject failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  /**
   * Rebuilds the comparison snapshot by republishing from GitHub.
   *
   * `baseline-lost` and `orphaned` are otherwise terminal: drift cannot be
   * measured, so publishing stays blocked and the document is frozen forever.
   * The way out is destructive — whatever is in the Doc is replaced — so it is a
   * manager's explicit decision rather than something the poller does quietly.
   */
  router.post('/api/docs/:workspaceId/google/rebaseline', deps.jsonBody, async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      const filePath = String(req.body?.filePath || '').trim();
      if (!filePath) {
        return apiError(res, 400, 'file_path_required');
      }
      if (!(await store.getGoogleDocMapping(workspaceId, filePath))) {
        return apiError(res, 404, 'google_doc_not_linked');
      }

      const markdown = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, filePath);
      if (markdown === null) {
        return apiError(res, 409, 'github_document_gone');
      }

      await retireReviewCards({
        workspaceId,
        githubPath: filePath,
        notice: { reason: 'gdocs.card.retired.republishedReview' },
        client: deps.slackClient,
      });
      await retireManualCards({
        workspaceId,
        githubPath: filePath,
        notice: { reason: 'gdocs.card.retired.rebaselinedManual' },
        client: deps.slackClient,
      });

      // For a preserved document this rebuilds the comparison snapshot from the
      // document itself rather than replacing it — which is what "rebaseline"
      // should mean there, and the only thing it is allowed to mean.
      const published = await publishReplica({ workspaceId, githubPath: filePath, markdown, force: true });
      const settled = published.outcome === 'published' || published.outcome === 'held-for-manual';
      if (settled) {
        return res.status(200).json({ outcome: published.outcome, detail: published.detail });
      }
      // `detail` stays the free-text string it has always been — the viewer
      // reads a string detail as the `{message}` the catalog sentence wraps —
      // so nothing that already parses this body has to change.
      const detail = published.detail ?? published.outcome;
      return res.status(500).json({
        outcome: published.outcome,
        ...apiErrorBodyFor('republish_failed', { message: detail }),
        detail,
      });
    } catch (err) {
      deps.logger.error('POST google/rebaseline failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });

  router.post('/api/docs/:workspaceId/google/disconnect', async (req: Req, res: Res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      if (!(await requireManagerOf(req, res, workspaceId))) {
        return undefined;
      }

      await retireAllReviewCards({
        workspaceId,
        notice: { reason: 'gdocs.card.retired.disconnectedReview' },
        client: deps.slackClient,
      });
      await retireAllManualCards({
        workspaceId,
        notice: { reason: 'gdocs.card.retired.disconnectedManual' },
        client: deps.slackClient,
      });
      await disconnectWorkspace(workspaceId);
      deps.logger.info('Disconnected the workspace Google account', { workspaceId });
      // Mappings survive on purpose: reconnecting the same account restores every
      // replica without re-picking each document.
      return res.json({ ok: true });
    } catch (err) {
      deps.logger.error('POST google/disconnect failed', err);
      return apiError(res, 500, 'internal_error');
    }
  });
}

/**
 * The import service reports refusals with its own outcome vocabulary and an
 * English `detail`. This turns one into the API's code, so the viewer can say
 * the same thing in the reader's language; `failed` keeps the detail as the
 * `{message}` its sentence wraps, because what went wrong there is assembled
 * deeper down (a trashed document, a missing repository, a GitHub error) and
 * cannot be enumerated from here.
 */
function importErrorBody(result: { outcome: string; githubPath?: string; detail?: string }, requestedPath: string) {
  const code: DocsApiErrorCode =
    result.outcome === 'exists'
      ? 'import_path_exists'
      : result.outcome === 'not-connected'
        ? 'google_not_connected'
        : result.outcome === 'invalid-path'
          ? 'import_invalid_path'
          : result.outcome === 'empty'
            ? 'import_empty'
            : 'import_failed';

  if (code === 'import_path_exists') {
    return apiErrorBodyFor(code, { path: result.githubPath ?? requestedPath });
  }
  if (code === 'import_failed') {
    return apiErrorBodyFor(code, { message: result.detail ?? result.outcome });
  }
  return apiErrorBodyFor(code);
}
