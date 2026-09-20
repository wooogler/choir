import type { WebClient } from '@slack/web-api';
import { getCachedChannelName } from 'services/common/name-cache';
import { apiError, writeAccessErrorBody } from 'services/docs-editor/api-errors';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { getProjectIndex, listProjects } from './project-index';
import { ProjectRefusal, deleteProject, saveProject } from './project-store';
import type { ProjectSettings } from './schema';
import { channelMembers, listChannels, privateChannelsReadable, projectMembers } from './slack-directory';

/**
 * HTTP surface for project folders — what the viewer's project settings dialog
 * reads and writes (docs/project-folders.md 6).
 *
 * Registered from app.ts, which owns session reading and express itself, so
 * those arrive as dependencies rather than being re-implemented here.
 *
 * IMPORTANT: these must be registered before `/api/docs/:workspaceId/*splat`,
 * which would otherwise swallow every `/api/docs/<id>/projects/...` path. And
 * within this module the `/members` route comes before the bare `*folder` one,
 * because an Express 5 splat is greedy: `/projects/a/b/members` would otherwise
 * match `*folder` with the folder `a/b/members`.
 */

export interface ProjectRouteDeps {
  readSession: (req: unknown) => Promise<{ workspaceId: string; userId: string } | null>;
  isManager: (workspaceId: string, userId: string) => Promise<boolean>;
  /** `express.json(...)`, for the one route with a body. */
  jsonBody: unknown;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, e?: unknown) => void;
  };
  /**
   * A bot-token client for that workspace, or null when there is none — a
   * workspace whose install was removed, or an `oauth` deployment that has not
   * seen this team. Per workspace rather than one shared client because in
   * `oauth` mode `app.client` carries no token at all.
   */
  slackClientFor: (workspaceId: string) => Promise<WebClient | null>;
}

// Express's router and handlers are untyped throughout app.ts (the receiver
// exposes them as `any`); these aliases keep that contained to one place.
type Router = { get: Handler; put: Handler; delete: Handler };
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
  end: (chunk?: string) => void;
};

type Session = { workspaceId: string; userId: string };

/** What a project looks like on the wire: its folder, flattened over its settings. */
export interface ProjectSummary extends ProjectSettings {
  folder: string;
  /** Best-effort display names for `channels`, when Slack could be reached. */
  channelNames?: Record<string, string>;
}

/** Express 5 hands a `*name` segment over as an array of path parts. */
function splatPath(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join('/');
  return String(value ?? '');
}

function summary(folder: string, settings: ProjectSettings, channelNames?: Record<string, string>): ProjectSummary {
  return { folder, ...settings, ...(channelNames ? { channelNames } : {}) };
}

export function registerProjectRoutes(router: Router, deps: ProjectRouteDeps): void {
  /**
   * Session, then workspace, then CHOIR manager — the same first three rungs
   * the "New document" route climbs. Reading the workspace from the URL alone
   * would let one workspace's manager enumerate another's channels.
   */
  const requireManager = async (req: Req, res: Res, workspaceId: string): Promise<Session | null> => {
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
    return session;
  };

  /**
   * The fourth rung, for the routes that end in a commit. A manager whose
   * GitHub account cannot push should be told before filling in a dialog, not
   * after — so the write routes climb it and the read routes do not.
   */
  const requireWriter = async (req: Req, res: Res, workspaceId: string): Promise<Session | null> => {
    const session = await requireManager(req, res, workspaceId);
    if (!session) return null;

    const writeAccess = await getDocsWriteAccess(workspaceId, session.userId);
    if (!writeAccess.canPush) {
      res.status(403).json(writeAccessErrorBody(writeAccess.reason, writeAccess.detail));
      return null;
    }
    return session;
  };

  /**
   * A Slack client for this workspace, or an answered 503.
   *
   * `null` is not a fault: a workspace can lose its installation, and the GUI
   * should say "channels are unavailable" rather than showing an empty list
   * that looks like "this workspace has no channels".
   */
  const requireSlack = async (res: Res, workspaceId: string): Promise<WebClient | null> => {
    const client = await deps.slackClientFor(workspaceId);
    if (!client) {
      apiError(res, 503, 'slack_unavailable', { message: 'no bot token for this workspace' });
      return null;
    }
    return client;
  };

  /** Every route ends here; a refusal is an answer, anything else is a fault. */
  const fail = (res: Res, route: string, err: unknown): unknown => {
    if (err instanceof ProjectRefusal) {
      return apiError(res, err.status, err.apiCode, err.detail);
    }
    deps.logger.error(`${route} failed`, err);
    return apiError(res, 500, 'internal_error');
  };

  // ── Projects ─────────────────────────────────────────────────────────────

  router.get('/api/docs/:workspaceId/projects', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      if (!(await requireManager(req, res, workspaceId))) return undefined;

      const index = await getProjectIndex(workspaceId);
      const records = await listProjects(workspaceId);

      // Channel names are a convenience, not the answer: a workspace whose
      // Slack install is gone still has its projects, and the list must render.
      const names = await channelNameMap(workspaceId, index.byChannel.keys(), deps);

      return res.json({
        projects: records.map((record) =>
          summary(record.folder, record.settings, pick(names, record.settings.channels)),
        ),
        broken: index.broken,
      });
    } catch (err) {
      return fail(res, 'GET projects', err);
    }
  });

  // Before the bare `*folder` route: see the note at the top of the file.
  router.get('/api/docs/:workspaceId/projects/*folder/members', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      if (!(await requireManager(req, res, workspaceId))) return undefined;

      const client = await requireSlack(res, workspaceId);
      if (!client) return undefined;

      const result = await projectMembers(workspaceId, splatPath(req.params.folder), client);
      return res.json(result);
    } catch (err) {
      return fail(res, 'GET project members', err);
    }
  });

  router.get('/api/docs/:workspaceId/projects/*folder', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      if (!(await requireManager(req, res, workspaceId))) return undefined;

      const folder = splatPath(req.params.folder);
      const index = await getProjectIndex(workspaceId);
      const settings = index.byFolder.get(folder);
      if (!settings) {
        return apiError(res, 404, 'project_not_found', { folder });
      }

      const names = await channelNameMap(workspaceId, settings.channels, deps);
      return res.json({ project: summary(folder, settings, pick(names, settings.channels)) });
    } catch (err) {
      return fail(res, 'GET project', err);
    }
  });

  router.put('/api/docs/:workspaceId/projects/*folder', deps.jsonBody, async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      const session = await requireWriter(req, res, workspaceId);
      if (!session) return undefined;

      const { commitSha, project } = await saveProject({
        workspaceId,
        userId: session.userId,
        folder: splatPath(req.params.folder),
        settings: req.body ?? {},
      });

      return res.json({ project: summary(project.folder, project.settings), commitSha });
    } catch (err) {
      return fail(res, 'PUT project', err);
    }
  });

  router.delete('/api/docs/:workspaceId/projects/*folder', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      const session = await requireWriter(req, res, workspaceId);
      if (!session) return undefined;

      await deleteProject({ workspaceId, userId: session.userId, folder: splatPath(req.params.folder) });
      return res.status(204).end();
    } catch (err) {
      return fail(res, 'DELETE project', err);
    }
  });

  // ── Slack directory ──────────────────────────────────────────────────────

  router.get('/api/docs/:workspaceId/slack/channels', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      if (!(await requireManager(req, res, workspaceId))) return undefined;

      const client = await requireSlack(res, workspaceId);
      if (!client) return undefined;

      const [channels, index, readable] = await Promise.all([
        listChannels(client),
        getProjectIndex(workspaceId),
        privateChannelsReadable(client, workspaceId),
      ]);

      return res.json({
        // `linkedFolder` is what greys a channel out in the dialog, so it must
        // come from the index rather than from the project being edited — the
        // conflicting project is a different one by definition.
        channels: channels.map((channel) => ({
          ...channel,
          ...(index.byChannel.has(channel.id) ? { linkedFolder: index.byChannel.get(channel.id) } : {}),
        })),
        privateChannelsReadable: readable,
      });
    } catch (err) {
      return fail(res, 'GET slack channels', err);
    }
  });

  router.get('/api/docs/:workspaceId/slack/channels/:channelId/members', async (req: Req, res: Res) => {
    const workspaceId = String(req.params.workspaceId);
    try {
      if (!(await requireManager(req, res, workspaceId))) return undefined;

      const client = await requireSlack(res, workspaceId);
      if (!client) return undefined;

      const result = await channelMembers(client, String(req.params.channelId), workspaceId);
      return res.json(result);
    } catch (err) {
      return fail(res, 'GET channel members', err);
    }
  });
}

/**
 * Display names for channel IDs, or an empty map.
 *
 * Every failure is swallowed on purpose: this decorates a list that is already
 * correct without it, and a workspace with no Slack install would otherwise be
 * unable to see its own projects.
 */
async function channelNameMap(
  workspaceId: string,
  channelIds: Iterable<string>,
  deps: ProjectRouteDeps,
): Promise<Record<string, string>> {
  const ids = [...channelIds];
  if (ids.length === 0) return {};

  try {
    const client = await deps.slackClientFor(workspaceId);
    if (!client) return {};

    const names: Record<string, string> = {};
    await Promise.all(
      ids.map(async (id) => {
        names[id] = await getCachedChannelName(id, workspaceId, client);
      }),
    );
    return names;
  } catch (err) {
    deps.logger.warn('Could not resolve channel names for the project list', { workspaceId, error: String(err) });
    return {};
  }
}

function pick(names: Record<string, string>, ids: string[]): Record<string, string> | undefined {
  const picked: Record<string, string> = {};
  for (const id of ids) {
    if (names[id]) picked[id] = names[id];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}
