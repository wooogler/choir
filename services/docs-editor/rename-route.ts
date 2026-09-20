import { apiError, writeAccessErrorBody } from './api-errors';
import { RenameDocumentRefusal, checkRename, renameDocument } from './rename-document';
import { getDocsWriteAccess } from './write-access';

/**
 * HTTP surface for renaming and moving a document.
 *
 * Two endpoints rather than one because the dialog has two questions. The
 * destination being taken, a Google Docs review being in the way and the number
 * of links about to break are all things the manager needs to see BEFORE
 * committing, and none of them can be answered in the browser — so `/check`
 * answers them without writing anything, and `/rename` is the commit.
 *
 * Registered from app.ts, which owns session reading and the body parser, so
 * those arrive as dependencies rather than being re-implemented here.
 *
 * IMPORTANT: these must be registered before `/api/docs/:workspaceId/*splat`,
 * which would otherwise swallow both paths — and the rename path is a literal
 * segment rather than a splat for the same reason "New document" is: the
 * document is moving between two paths, so neither is the resource being
 * addressed and both belong in the body.
 */

export interface RenameRouteDeps {
  readSession: (req: unknown) => Promise<{ workspaceId: string; userId: string } | null>;
  isManager: (workspaceId: string, userId: string) => Promise<boolean>;
  /** `express.json(...)`, since both routes carry one. */
  jsonBody: unknown;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
}

// Express's router and handlers are untyped throughout app.ts (the receiver
// exposes them as `any`); these aliases keep that contained to one place.
type Router = { get: Handler; post: Handler; delete: Handler };
type Handler = (path: string, ...rest: unknown[]) => void;
type Req = {
  params: Record<string, string | string[]>;
  query: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};
type Res = {
  status: (code: number) => Res;
  json: (body: unknown) => Res;
  send: (body: unknown) => Res;
};

type Session = { workspaceId: string; userId: string };

export function registerRenameRoutes(router: Router, deps: RenameRouteDeps): void {
  /**
   * The same four rungs the "New document" route climbs: session, workspace,
   * CHOIR manager, GitHub push access. `/check` climbs it too although it writes
   * nothing — it reports on a repository, and a manager who cannot push should
   * be told that before typing a new path rather than after.
   */
  const requireRenamer = async (req: Req, res: Res, workspaceId: string): Promise<Session | null> => {
    const session = await deps.readSession(req);
    if (!session) {
      apiError(res, 401, 'not_signed_in');
      return null;
    }
    if (session.workspaceId !== workspaceId) {
      apiError(res, 403, 'workspace_mismatch');
      return null;
    }
    if (!(await deps.isManager(workspaceId, session.userId))) {
      apiError(res, 403, 'not_a_manager');
      return null;
    }

    const writeAccess = await getDocsWriteAccess(workspaceId, session.userId);
    if (!writeAccess.canPush) {
      res.status(403).json(writeAccessErrorBody(writeAccess.reason, writeAccess.detail));
      return null;
    }

    return session;
  };

  /** `{ from, to }`, refused as a bad request when either is missing. */
  const readPair = (req: Req, res: Res): { from: string; to: string } | null => {
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';
    if (!from.trim() || !to.trim()) {
      apiError(res, 400, 'document_path_required');
      return null;
    }
    return { from, to };
  };

  /**
   * Both handlers answer a `RenameDocumentRefusal` with the status and code it
   * carries: an unusable path, an occupied one and a pending review are all
   * things the manager can fix from the dialog, so none is worth a log line.
   */
  const answerFailure = (res: Res, err: unknown, where: string): unknown => {
    if (err instanceof RenameDocumentRefusal) {
      return apiError(res, err.status, err.apiCode, err.detail);
    }
    deps.logger.error(`${where} failed`, err);
    return apiError(res, 500, 'internal_error');
  };

  // ── Preflight: what the dialog shows before the manager commits ───────────
  router.post(
    '/api/docs/:workspaceId/documents/rename/check',
    deps.jsonBody,
    async (req: Req, res: Res): Promise<unknown> => {
      const workspaceId = String(req.params.workspaceId);
      try {
        const session = await requireRenamer(req, res, workspaceId);
        if (!session) return undefined;

        const pair = readPair(req, res);
        if (!pair) return undefined;

        const result = await checkRename({ workspaceId, userId: session.userId, ...pair });
        return res.json(result);
      } catch (err) {
        return answerFailure(res, err, 'POST /api/docs documents/rename/check');
      }
    },
  );

  // ── The rename itself ─────────────────────────────────────────────────────
  router.post(
    '/api/docs/:workspaceId/documents/rename',
    deps.jsonBody,
    async (req: Req, res: Res): Promise<unknown> => {
      const workspaceId = String(req.params.workspaceId);
      try {
        const session = await requireRenamer(req, res, workspaceId);
        if (!session) return undefined;

        const pair = readPair(req, res);
        if (!pair) return undefined;

        const result = await renameDocument({ workspaceId, userId: session.userId, ...pair });
        deps.logger.info('Document renamed', { workspaceId, ...result });
        return res.json(result);
      } catch (err) {
        return answerFailure(res, err, 'POST /api/docs documents/rename');
      }
    },
  );
}
