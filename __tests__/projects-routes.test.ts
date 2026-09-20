/**
 * The HTTP surface of project folders: the auth ladder every route climbs, what
 * each one puts on the wire, and the one piece of Express behaviour this module
 * has to get right — a greedy `*folder` splat that arrives as an array of path
 * parts and must not swallow `/members`.
 *
 * The store, the index and Slack are mocked: each has its own suite, and
 * between them they pull octokit and a data directory into a process jest would
 * rather not load.
 */

import type { WebClient } from '@slack/web-api';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { getProjectIndex, listProjects } from 'services/projects/project-index';
import { registerProjectRoutes } from 'services/projects/routes';
import type { ProjectSettings } from 'services/projects/schema';
import {
  channelMembers,
  listChannels,
  privateChannelsReadable,
  projectMembers,
} from 'services/projects/slack-directory';

jest.mock('services/docs-editor/write-access', () => ({ getDocsWriteAccess: jest.fn() }));
jest.mock('services/projects/project-index', () => ({ getProjectIndex: jest.fn(), listProjects: jest.fn() }));
jest.mock('services/projects/project-store', () => {
  // The routes answer a refusal with its own status and code, so the class has
  // to be a real one `instanceof` recognises.
  const { ProjectRefusal } = jest.requireActual('services/projects/refusal');
  return { ProjectRefusal, saveProject: jest.fn(), deleteProject: jest.fn() };
});
jest.mock('services/projects/slack-directory', () => ({
  listChannels: jest.fn(),
  channelMembers: jest.fn(),
  projectMembers: jest.fn(),
  privateChannelsReadable: jest.fn(),
}));
jest.mock('services/common/name-cache', () => ({ getCachedChannelName: jest.fn(async (id: string) => `name-${id}`) }));

import { ProjectRefusal, deleteProject, saveProject } from 'services/projects/project-store';

const mockIndex = getProjectIndex as jest.MockedFunction<typeof getProjectIndex>;
const mockList = listProjects as jest.MockedFunction<typeof listProjects>;
const mockSave = saveProject as jest.MockedFunction<typeof saveProject>;
const mockDelete = deleteProject as jest.MockedFunction<typeof deleteProject>;
const mockWriteAccess = getDocsWriteAccess as jest.MockedFunction<typeof getDocsWriteAccess>;
const mockChannels = listChannels as jest.MockedFunction<typeof listChannels>;
const mockChannelMembers = channelMembers as jest.MockedFunction<typeof channelMembers>;
const mockProjectMembers = projectMembers as jest.MockedFunction<typeof projectMembers>;
const mockPrivateReadable = privateChannelsReadable as jest.MockedFunction<typeof privateChannelsReadable>;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const MANAGER = { workspaceId: 'T1', userId: 'U-manager' };
const FAKE_CLIENT = { token: 'xoxb-fake' } as unknown as WebClient;

let session: { workspaceId: string; userId: string } | null = MANAGER;
let managerResult = true;
let slackClient: WebClient | null = FAKE_CLIENT;
const routes: Array<{ method: string; path: string; handler: Handler }> = [];

function route(method: string, routePath: string): Handler {
  const found = routes.find((entry) => entry.method === method && entry.path === routePath);
  if (!found) throw new Error(`No ${method} ${routePath} registered`);
  return found.handler;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { params: { workspaceId: 'T1' }, query: {}, headers: {}, ...overrides };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res;
}

function settings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    version: 1,
    name: 'Alpha',
    description: '',
    channels: ['C0AA'],
    members: { source: 'channels', curated: [], aliases: {} },
    scope: { retrieval: 'boost', updates: 'folder' },
    meetingsFolder: 'meetings',
    glossary: 'GLOSSARY.md',
    ...overrides,
  };
}

function index(projects: Array<[string, ProjectSettings]> = [], broken: Array<{ folder: string; error: string }> = []) {
  const byFolder = new Map(projects);
  const byChannel = new Map<string, string>();
  for (const [folder, value] of projects) {
    for (const channel of value.channels) byChannel.set(channel, folder);
  }
  return { byFolder, byChannel, broken };
}

beforeAll(() => {
  registerProjectRoutes(
    {
      get: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'get', path: routePath, handler: rest[rest.length - 1] as Handler }),
      put: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'put', path: routePath, handler: rest[rest.length - 1] as Handler }),
      delete: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'delete', path: routePath, handler: rest[rest.length - 1] as Handler }),
    } as never,
    {
      readSession: async () => session,
      isManager: async () => managerResult,
      jsonBody: (_req: unknown, _res: unknown, next: () => void) => next(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      slackClientFor: async () => slackClient,
    } as never,
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  session = MANAGER;
  managerResult = true;
  slackClient = FAKE_CLIENT;
  mockWriteAccess.mockResolvedValue({ connected: true, canPush: true, repo: 'acme/docs' });
  mockIndex.mockResolvedValue(index());
  mockList.mockResolvedValue([]);
});

describe('the auth ladder', () => {
  it('registers /members ahead of the greedy folder splat', () => {
    const paths = routes.filter((entry) => entry.method === 'get').map((entry) => entry.path);
    expect(paths.indexOf('/api/docs/:workspaceId/projects/*folder/members')).toBeLessThan(
      paths.indexOf('/api/docs/:workspaceId/projects/*folder'),
    );
  });

  it('refuses without a session, for another workspace, and without manager rights', async () => {
    const handler = route('get', '/api/docs/:workspaceId/projects');

    session = null;
    let res = makeRes();
    await handler(makeReq(), res);
    expect([res.statusCode, (res.body as { error: string }).error]).toEqual([401, 'not_signed_in']);

    session = { workspaceId: 'T-other', userId: 'U-manager' };
    res = makeRes();
    await handler(makeReq(), res);
    expect([res.statusCode, (res.body as { error: string }).error]).toEqual([403, 'workspace_mismatch']);

    session = MANAGER;
    managerResult = false;
    res = makeRes();
    await handler(makeReq(), res);
    expect([res.statusCode, (res.body as { error: string }).error]).toEqual([403, 'not_a_manager']);
  });

  it('adds the push-access rung for PUT and DELETE only', async () => {
    mockWriteAccess.mockResolvedValue({ connected: true, canPush: false, reason: 'github_repo_read_only' } as never);
    mockIndex.mockResolvedValue(index([['alpha', settings()]]));

    const res = makeRes();
    await route('put', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['alpha'] }, body: { name: 'Alpha' } }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('github_repo_read_only');
    expect(mockSave).not.toHaveBeenCalled();

    // The same workspace can still read.
    const readRes = makeRes();
    await route('get', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['alpha'] } }),
      readRes,
    );
    expect(readRes.statusCode).toBe(200);
  });
});

describe('GET /projects', () => {
  it('flattens each project over its folder and reports the broken files', async () => {
    mockIndex.mockResolvedValue(
      index([['projects/alpha', settings()]], [{ folder: 'beta', error: 'is not valid JSON' }]),
    );
    mockList.mockResolvedValue([{ folder: 'projects/alpha', settings: settings() }]);

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/projects')(makeReq(), res);

    const body = res.body as { projects: Array<Record<string, unknown>>; broken: unknown[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      folder: 'projects/alpha',
      name: 'Alpha',
      channels: ['C0AA'],
      channelNames: { C0AA: 'name-C0AA' },
    });
    expect(body.broken).toEqual([{ folder: 'beta', error: 'is not valid JSON' }]);
  });

  it('still answers when Slack is gone — names are a decoration', async () => {
    slackClient = null;
    mockIndex.mockResolvedValue(index([['alpha', settings()]]));
    mockList.mockResolvedValue([{ folder: 'alpha', settings: settings() }]);

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/projects')(makeReq(), res);

    const body = res.body as { projects: Array<Record<string, unknown>> };
    expect(res.statusCode).toBe(200);
    expect(body.projects[0].channelNames).toBeUndefined();
  });
});

describe('GET /projects/*folder', () => {
  it('joins the splat back into a nested folder', async () => {
    mockIndex.mockResolvedValue(index([['projects/alpha/paper', settings({ name: 'Paper' })]]));

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['projects', 'alpha', 'paper'] } }),
      res,
    );
    expect((res.body as { project: Record<string, unknown> }).project).toMatchObject({
      folder: 'projects/alpha/paper',
      name: 'Paper',
    });
  });

  it('404s a folder that is not a project', async () => {
    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['nowhere'] } }),
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'project_not_found', detail: { folder: 'nowhere' } });
  });
});

describe('PUT /projects/*folder', () => {
  it('saves the body and answers with the project and the commit', async () => {
    mockSave.mockResolvedValue({ commitSha: 'sha-1', project: { folder: 'alpha', settings: settings() } });

    const res = makeRes();
    await route('put', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['alpha'] }, body: { name: 'Alpha', channels: ['C0AA'] } }),
      res,
    );

    expect(mockSave).toHaveBeenCalledWith({
      workspaceId: 'T1',
      userId: 'U-manager',
      folder: 'alpha',
      settings: { name: 'Alpha', channels: ['C0AA'] },
    });
    expect(res.body).toEqual({ project: { folder: 'alpha', ...settings() }, commitSha: 'sha-1' });
  });

  it('passes a refusal through with its own status, code and detail', async () => {
    mockSave.mockRejectedValue(new ProjectRefusal(409, 'project_channel_taken', { channel: 'C0AA', folder: 'beta' }));

    const res = makeRes();
    await route('put', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['alpha'] }, body: { name: 'Alpha' } }),
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      error: 'project_channel_taken',
      detail: { channel: 'C0AA', folder: 'beta' },
    });
  });

  it('answers an unexpected failure as a 500 without leaking it', async () => {
    mockSave.mockRejectedValue(new Error('GitHub exploded'));

    const res = makeRes();
    await route('put', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['alpha'] }, body: { name: 'Alpha' } }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe('internal_error');
  });
});

describe('DELETE /projects/*folder', () => {
  it('answers 204 with no body', async () => {
    mockDelete.mockResolvedValue({ commitSha: 'sha-1', folder: 'alpha' });

    const res = makeRes();
    await route('delete', '/api/docs/:workspaceId/projects/*folder')(
      makeReq({ params: { workspaceId: 'T1', folder: ['alpha'] } }),
      res,
    );
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith({ workspaceId: 'T1', userId: 'U-manager', folder: 'alpha' });
  });
});

describe('the Slack routes', () => {
  it('marks a channel that already belongs to a project', async () => {
    mockIndex.mockResolvedValue(index([['alpha', settings()]]));
    mockChannels.mockResolvedValue([
      { id: 'C0AA', name: 'alpha-dev', isPrivate: false, isArchived: false, memberCount: 4 },
      { id: 'C0BB', name: 'random', isPrivate: false, isArchived: false },
    ]);
    mockPrivateReadable.mockResolvedValue(false);

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/slack/channels')(makeReq(), res);

    expect(res.body).toEqual({
      channels: [
        { id: 'C0AA', name: 'alpha-dev', isPrivate: false, isArchived: false, memberCount: 4, linkedFolder: 'alpha' },
        { id: 'C0BB', name: 'random', isPrivate: false, isArchived: false },
      ],
      privateChannelsReadable: false,
    });
  });

  it('hands the channel members straight through', async () => {
    mockChannelMembers.mockResolvedValue({ members: [{ id: 'U1', name: 'Ada', isBot: false }] });

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/slack/channels/:channelId/members')(
      makeReq({ params: { workspaceId: 'T1', channelId: 'C0AA' } }),
      res,
    );
    expect(mockChannelMembers).toHaveBeenCalledWith(FAKE_CLIENT, 'C0AA', 'T1');
    expect(res.body).toEqual({ members: [{ id: 'U1', name: 'Ada', isBot: false }] });
  });

  it('answers the project members with their source and any warning', async () => {
    mockProjectMembers.mockResolvedValue({
      members: [{ id: 'U1', name: 'Ada', isBot: false, aliases: ['Ada L.'] }],
      source: 'channels',
      warning: 'C0AA: not_in_channel',
    });

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/projects/*folder/members')(
      makeReq({ params: { workspaceId: 'T1', folder: ['projects', 'alpha'] } }),
      res,
    );
    expect(mockProjectMembers).toHaveBeenCalledWith('T1', 'projects/alpha', FAKE_CLIENT);
    expect(res.body).toMatchObject({ source: 'channels', warning: 'C0AA: not_in_channel' });
  });

  it('turns a missing scope into a 403 the GUI can act on', async () => {
    mockChannels.mockRejectedValue(new ProjectRefusal(403, 'slack_scope_missing', { scope: 'groups:read' }));
    mockPrivateReadable.mockResolvedValue(false);

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/slack/channels')(makeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'slack_scope_missing', detail: { scope: 'groups:read' } });
  });

  it('503s when the workspace has no bot token', async () => {
    slackClient = null;

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/slack/channels')(makeReq(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      error: 'slack_unavailable',
      detail: { message: 'no bot token for this workspace' },
    });
    expect(mockChannels).not.toHaveBeenCalled();
  });
});
