/**
 * The HTTP surface of rename: the auth ladder both endpoints climb, and that a
 * refusal arrives with its own status and code rather than as a 500. The rename
 * itself is mocked — it has its own suite, and between them the two would pull
 * the GitHub client and the Google graph into a process jest would rather not
 * load.
 */

import { getDocsWriteAccess } from 'services/docs-editor/write-access';

jest.mock('services/docs-editor/rename-document', () => {
  // The route answers a refusal with the status and code it carries, so the
  // class has to be a real one `instanceof` recognises.
  class RenameDocumentRefusal extends Error {
    readonly status: number;
    readonly apiCode: string;
    readonly detail?: Record<string, string | number>;
    constructor(status: number, apiCode: string, detail?: Record<string, string | number>) {
      super(apiCode);
      this.name = 'RenameDocumentRefusal';
      this.status = status;
      this.apiCode = apiCode;
      this.detail = detail;
    }
  }
  return { renameDocument: jest.fn(), checkRename: jest.fn(), RenameDocumentRefusal };
});
jest.mock('services/docs-editor/write-access', () => ({ getDocsWriteAccess: jest.fn() }));

import { RenameDocumentRefusal, checkRename, renameDocument } from 'services/docs-editor/rename-document';
import { registerRenameRoutes } from 'services/docs-editor/rename-route';

const mockRename = renameDocument as jest.MockedFunction<typeof renameDocument>;
const mockCheck = checkRename as jest.MockedFunction<typeof checkRename>;
const mockWriteAccess = getDocsWriteAccess as jest.MockedFunction<typeof getDocsWriteAccess>;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const MANAGER = { workspaceId: 'T1', userId: 'U-manager' };
const CHECK_PATH = '/api/docs/:workspaceId/documents/rename/check';
const RENAME_PATH = '/api/docs/:workspaceId/documents/rename';

let session: { workspaceId: string; userId: string } | null = MANAGER;
let managerResult = true;
const routes: Array<{ method: string; path: string; handler: Handler }> = [];

function route(method: string, routePath: string): Handler {
  const found = routes.find((entry) => entry.method === method && entry.path === routePath);
  if (!found) throw new Error(`No ${method} ${routePath} registered`);
  return found.handler;
}

function makeReq(body: unknown = { from: 'policy/onboarding.md', to: 'policy/welcome.md' }) {
  return { params: { workspaceId: 'T1' }, query: {}, headers: {}, body };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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
  };
  return res;
}

beforeAll(() => {
  registerRenameRoutes(
    {
      get: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'get', path: routePath, handler: rest[rest.length - 1] as Handler }),
      post: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'post', path: routePath, handler: rest[rest.length - 1] as Handler }),
      delete: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'delete', path: routePath, handler: rest[rest.length - 1] as Handler }),
    } as never,
    {
      readSession: async () => session,
      isManager: async () => managerResult,
      jsonBody: (_req: unknown, _res: unknown, next: () => void) => next(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never,
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  session = MANAGER;
  managerResult = true;
  mockWriteAccess.mockResolvedValue({ connected: true, canPush: true, repo: 'acme/docs' });
});

describe.each([
  ['the preflight', CHECK_PATH],
  ['the rename', RENAME_PATH],
])('rename routes: the auth ladder on %s', (_label, routePath) => {
  it('refuses a request with no session', async () => {
    session = null;
    const res = makeRes();
    await route('post', routePath)(makeReq(), res);

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('not_signed_in');
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('refuses a session belonging to another workspace', async () => {
    session = { workspaceId: 'T2', userId: 'U-manager' };
    const res = makeRes();
    await route('post', routePath)(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('workspace_mismatch');
  });

  it('refuses a non-manager', async () => {
    managerResult = false;
    const res = makeRes();
    await route('post', routePath)(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('not_a_manager');
  });

  it('refuses a manager whose GitHub account cannot push', async () => {
    mockWriteAccess.mockResolvedValue({
      connected: true,
      canPush: false,
      reason: 'github_repo_read_only',
      detail: { repo: 'acme/docs' },
    });
    const res = makeRes();
    await route('post', routePath)(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'github_repo_read_only', code: 'GITHUB_WRITE_FORBIDDEN' });
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('refuses a body missing either path', async () => {
    const res = makeRes();
    await route('post', routePath)(makeReq({ from: 'policy/onboarding.md' }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('document_path_required');
  });
});

describe('POST .../documents/rename/check', () => {
  it('answers with the preflight, as the manager asking it', async () => {
    mockCheck.mockResolvedValue({
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
      exists: false,
      reviewPending: false,
      inboundLinks: 3,
      sameFolder: true,
    });

    const res = makeRes();
    await route('post', CHECK_PATH)(makeReq(), res);

    expect(mockCheck).toHaveBeenCalledWith({
      workspaceId: 'T1',
      userId: 'U-manager',
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ inboundLinks: 3, exists: false, reviewPending: false });
  });

  it('answers an unusable path with 400 rather than a preflight', async () => {
    mockCheck.mockRejectedValue(new RenameDocumentRefusal(400, 'invalid_document_path'));

    const res = makeRes();
    await route('post', CHECK_PATH)(makeReq({ from: 'a.md', to: 'b.txt' }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_document_path');
  });
});

describe('POST .../documents/rename', () => {
  it('renames and answers with the commit and the link warning', async () => {
    mockRename.mockResolvedValue({
      commitSha: 'deadbeefcafe',
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
      inboundLinks: 2,
    });

    const res = makeRes();
    await route('post', RENAME_PATH)(makeReq(), res);

    expect(mockRename).toHaveBeenCalledWith({
      workspaceId: 'T1',
      userId: 'U-manager',
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      commitSha: 'deadbeefcafe',
      from: 'policy/onboarding.md',
      to: 'policy/welcome.md',
      inboundLinks: 2,
    });
  });

  it('answers an occupied destination with the refusal’s own status and detail', async () => {
    mockRename.mockRejectedValue(new RenameDocumentRefusal(409, 'document_exists', { path: 'policy/welcome.md' }));

    const res = makeRes();
    await route('post', RENAME_PATH)(makeReq(), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'document_exists', detail: { path: 'policy/welcome.md' } });
  });

  it('answers an open Google Docs review with rename_review_pending', async () => {
    mockRename.mockRejectedValue(new RenameDocumentRefusal(409, 'rename_review_pending'));

    const res = makeRes();
    await route('post', RENAME_PATH)(makeReq(), res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe('rename_review_pending');
  });

  it('answers anything else as a 500, which is a fault of ours', async () => {
    mockRename.mockRejectedValue(new Error('GitHub is down'));

    const res = makeRes();
    await route('post', RENAME_PATH)(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe('internal_error');
  });
});
