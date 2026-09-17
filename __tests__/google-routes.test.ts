import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from 'services/db/connection';
import { getDocMeta } from 'services/google/drive-client';
import { getWorkspaceClient } from 'services/google/google-auth-service';
import { importGoogleDoc } from 'services/google/import-service';
import { issuePickerNonce } from 'services/google/picker-nonce';
import { publishReplica } from 'services/google/replica-publisher';
import { approveReview, buildReview, rejectReview } from 'services/google/review-service';
import { registerGoogleDriveRoutes } from 'services/google/routes';
import { type WorkspaceConfig, WorkspaceStore } from 'services/workspace/workspace-store';

jest.mock('services/google/drive-client', () => ({ getDocMeta: jest.fn() }));
// The review service is covered by its own suite; here it stands in so the
// routes can be exercised without pulling the GitHub stack into jest.
jest.mock('services/google/review-service', () => ({
  buildReview: jest.fn(),
  approveReview: jest.fn(),
  rejectReview: jest.fn(),
}));
jest.mock('services/google/replica-publisher', () => ({ publishReplica: jest.fn() }));
// Same reason as the review service: its own suite covers what it does, and it
// reaches the GitHub client, which jest cannot load.
jest.mock('services/google/import-service', () => ({ importGoogleDoc: jest.fn() }));
jest.mock('services/google/google-auth-service', () => ({
  getWorkspaceClient: jest.fn(),
  disconnectWorkspace: jest.fn(),
  buildAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?x=1'),
  exchangeCodeForCredential: jest.fn(),
  GoogleNotConfiguredError: class extends Error {},
}));

const mockGetDocMeta = getDocMeta as jest.MockedFunction<typeof getDocMeta>;
const mockPublish = publishReplica as jest.MockedFunction<typeof publishReplica>;
const mockClient = getWorkspaceClient as jest.MockedFunction<typeof getWorkspaceClient>;
const mockBuildReview = buildReview as jest.MockedFunction<typeof buildReview>;
const mockApprove = approveReview as jest.MockedFunction<typeof approveReview>;
const mockReject = rejectReview as jest.MockedFunction<typeof rejectReview>;
const mockImport = importGoogleDoc as jest.MockedFunction<typeof importGoogleDoc>;

interface Captured {
  method: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<unknown>;
}

/** Collects the registered handlers so they can be invoked without a server. */
function collectRoutes(isManagerResult = true) {
  const routes: Captured[] = [];
  const record =
    (method: string) =>
    (routePath: string, ...rest: unknown[]) => {
      routes.push({ method, path: routePath, handler: rest[rest.length - 1] as Captured['handler'] });
    };

  registerGoogleDriveRoutes(
    { get: record('get'), post: record('post'), delete: record('delete') } as never,
    {
      readSession: async () => ({ workspaceId: 'T1', userId: 'U-manager' }),
      isManager: async () => isManagerResult,
      cookieSecure: false,
      jsonBody: (_req: unknown, _res: unknown, next: () => void) => next(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      sanitizeNextPath: (next: string) => next,
    } as never,
  );

  return (method: string, routePath: string) => {
    const found = routes.find((route) => route.method === method && route.path === routePath);
    if (!found) throw new Error(`No ${method} ${routePath} registered`);
    return found.handler;
  };
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
    json(body: unknown) {
      res.body = body;
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
    // The import route streams progress when asked for NDJSON; these record
    // what a real response would have put on the wire.
    written: [] as string[],
    ended: false,
    headersSent: false,
    flushHeaders() {
      res.headersSent = true;
    },
    write(chunk: string) {
      res.written.push(chunk);
      res.headersSent = true;
      return true;
    },
    end(chunk?: string) {
      if (chunk) res.written.push(chunk);
      res.ended = true;
      return res;
    },
    /** The streamed body, one parsed object per line. */
    lines() {
      return res.written
        .join('')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
  return res;
}

const baseConfig = (workspaceId: string): WorkspaceConfig => ({
  workspaceId,
  managers: ['U-manager'],
  choirUsers: ['U-manager'],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('Google Drive routes', () => {
  let tempDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    jest.clearAllMocks();
    closeDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choir-gdocs-routes-'));
    process.env.DATABASE_URL = `file:${path.join(tempDir, 'choir.db')}`;
    process.env.CHOIR_DB_KEY_FILE = path.join(tempDir, '.db-key');
    process.env.CHOIR_DATA_DIR = tempDir;
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_PICKER_API_KEY = 'picker-key';
    process.env.GOOGLE_PROJECT_NUMBER = '1234567890';

    store = new WorkspaceStore();
    await store.saveWorkspaceConfig(baseConfig('T1'));

    const repoRoot = path.join(tempDir, 'workspaces', 'T1', 'repo', 'docs');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'a.md'), '# Title\n');

    mockClient.mockResolvedValue({ getAccessToken: async () => ({ token: 'ya29.access' }) } as never);
    mockGetDocMeta.mockResolvedValue({
      fileId: 'file-a',
      webViewLink: 'https://docs.google.com/document/d/file-a/edit',
    });
    mockPublish.mockResolvedValue({ outcome: 'published' });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of [
      'DATABASE_URL',
      'CHOIR_DB_KEY_FILE',
      'CHOIR_DATA_DIR',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_PICKER_API_KEY',
      'GOOGLE_PROJECT_NUMBER',
    ]) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  describe('authorization', () => {
    it('rejects a session belonging to another workspace', async () => {
      const route = collectRoutes();
      const res = makeRes();

      // The session says T1; asking for T2 must not mint T2's picker token.
      await route('post', '/api/docs/:workspaceId/google/picker-token')({ params: { workspaceId: 'T2' } }, res);

      expect(res.statusCode).toBe(401);
      expect(mockClient).not.toHaveBeenCalled();
    });

    it('rejects a non-manager', async () => {
      const route = collectRoutes(false);
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/picker-token')({ params: { workspaceId: 'T1' } }, res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('picker token', () => {
    it('returns a freshly minted token with the picker configuration', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/picker-token')({ params: { workspaceId: 'T1' } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ accessToken: 'ya29.access', apiKey: 'picker-key', appId: '1234567890' });
      expect((res.body as { pickerNonce: string }).pickerNonce).toBeTruthy();
    });

    it('reports a missing picker configuration rather than failing opaquely', async () => {
      Reflect.deleteProperty(process.env, 'GOOGLE_PICKER_API_KEY');
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/picker-token')({ params: { workspaceId: 'T1' } }, res);

      expect(res.statusCode).toBe(503);
    });

    it('tells the manager to connect an account first', async () => {
      mockClient.mockResolvedValue(null);
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/picker-token')({ params: { workspaceId: 'T1' } }, res);

      expect(res.statusCode).toBe(409);
    });
  });

  describe('linking a document', () => {
    const linkBody = (overrides: Record<string, unknown> = {}) => ({
      params: { workspaceId: 'T1' },
      body: {
        filePath: 'docs/a.md',
        fileId: 'file-a',
        pickerNonce: issuePickerNonce('T1', 'U-manager'),
        ...overrides,
      },
    });

    it('stores the mapping and immediately replaces the document content', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/link')(linkBody(), res);

      expect(res.statusCode).toBe(200);
      expect((await store.getGoogleDocMapping('T1', 'docs/a.md'))?.fileId).toBe('file-a');
      // Force, because a freshly linked document has no recorded hash or state
      // and the existing content must go now, not at some later GitHub change.
      expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ force: true, markdown: '# Title\n' }));
    });

    it('refuses a link without a nonce from a recent pick', async () => {
      const route = collectRoutes();
      const res = makeRes();

      // Otherwise a bare POST could overwrite any document the workspace account
      // can reach, including one a person granted months ago.
      await route('post', '/api/docs/:workspaceId/google/link')(linkBody({ pickerNonce: 'forged' }), res);

      expect(res.statusCode).toBe(400);
      expect(mockPublish).not.toHaveBeenCalled();
      expect(await store.getGoogleDocMapping('T1', 'docs/a.md')).toBeNull();
    });

    it('imports a picked document and reports where it landed', async () => {
      const route = collectRoutes();
      const res = makeRes();
      mockImport.mockResolvedValue({ outcome: 'imported', githubPath: 'notes/imported.md', linked: true });

      await route('post', '/api/docs/:workspaceId/google/import')(
        {
          params: { workspaceId: 'T1' },
          body: {
            filePath: 'notes/imported.md',
            fileId: 'file-a',
            pickerNonce: issuePickerNonce('T1', 'U-manager'),
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(mockImport).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'T1', githubPath: 'notes/imported.md', fileId: 'file-a' }),
      );
    });

    it('streams each step and then the result when NDJSON is asked for', async () => {
      const route = collectRoutes();
      const res = makeRes();
      mockImport.mockImplementation(async (params) => {
        params.onProgress?.({ step: 'checking', index: 1, total: 6, label: 'Checking the repository' });
        params.onProgress?.({ step: 'committing', index: 3, total: 6, label: 'Committing to GitHub' });
        return { outcome: 'imported', githubPath: 'notes/imported.md', linked: true };
      });

      await route('post', '/api/docs/:workspaceId/google/import')(
        {
          params: { workspaceId: 'T1' },
          headers: { accept: 'application/x-ndjson' },
          body: {
            filePath: 'notes/imported.md',
            fileId: 'file-a',
            pickerNonce: issuePickerNonce('T1', 'U-manager'),
          },
        },
        res,
      );

      expect(String(res.headers['Content-Type'])).toContain('application/x-ndjson');
      expect(res.lines()).toEqual([
        { type: 'progress', step: 'checking', index: 1, total: 6, label: 'Checking the repository' },
        { type: 'progress', step: 'committing', index: 3, total: 6, label: 'Committing to GitHub' },
        { type: 'result', outcome: 'imported', githubPath: 'notes/imported.md', linked: true },
      ]);
      expect(res.ended).toBe(true);
    });

    it('reports a streamed failure on the last line, the status line being long gone', async () => {
      const route = collectRoutes();
      const res = makeRes();
      mockImport.mockImplementation(async (params) => {
        params.onProgress?.({ step: 'checking', index: 1, total: 6, label: 'Checking the repository' });
        return { outcome: 'exists', detail: 'a.md already exists in this repository' };
      });

      await route('post', '/api/docs/:workspaceId/google/import')(
        {
          params: { workspaceId: 'T1' },
          headers: { accept: 'application/x-ndjson' },
          body: { filePath: 'a.md', fileId: 'file-a', pickerNonce: issuePickerNonce('T1', 'U-manager') },
        },
        res,
      );

      const lines = res.lines();
      expect(lines[lines.length - 1]).toEqual({
        type: 'error',
        error: 'a.md already exists in this repository',
        code: 'exists',
        status: 409,
      });
      expect(res.statusCode).toBe(200);
    });

    it('still answers a plain JSON caller with a single body', async () => {
      const route = collectRoutes();
      const res = makeRes();
      mockImport.mockResolvedValue({ outcome: 'imported', githubPath: 'notes/imported.md', linked: true });

      await route('post', '/api/docs/:workspaceId/google/import')(
        {
          params: { workspaceId: 'T1' },
          headers: { accept: 'application/json' },
          body: {
            filePath: 'notes/imported.md',
            fileId: 'file-a',
            pickerNonce: issuePickerNonce('T1', 'U-manager'),
          },
        },
        res,
      );

      expect(res.written).toEqual([]);
      expect(res.body).toEqual({ outcome: 'imported', githubPath: 'notes/imported.md', linked: true });
      expect(res.headers['Content-Type']).toBeUndefined();
    });

    it('refuses an import without a nonce from a recent pick', async () => {
      const route = collectRoutes();
      const res = makeRes();

      // A bare POST would commit the contents of any document the workspace
      // account can reach, to a path of the caller's choosing.
      await route('post', '/api/docs/:workspaceId/google/import')(
        { params: { workspaceId: 'T1' }, body: { filePath: 'a.md', fileId: 'file-a', pickerNonce: 'forged' } },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(mockImport).not.toHaveBeenCalled();
    });

    it('reports an import onto an existing path as a conflict', async () => {
      const route = collectRoutes();
      const res = makeRes();
      mockImport.mockResolvedValue({ outcome: 'exists', detail: 'a.md already exists in this repository' });

      await route('post', '/api/docs/:workspaceId/google/import')(
        {
          params: { workspaceId: 'T1' },
          body: { filePath: 'a.md', fileId: 'file-a', pickerNonce: issuePickerNonce('T1', 'U-manager') },
        },
        res,
      );

      expect(res.statusCode).toBe(409);
    });

    it('refuses a nonce issued to a different manager', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/link')(
        linkBody({ pickerNonce: issuePickerNonce('T1', 'U-someone-else') }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it('refuses a nonce issued for a different workspace', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/link')(
        linkBody({ pickerNonce: issuePickerNonce('T2', 'U-manager') }),
        res,
      );

      expect(res.statusCode).toBe(400);
    });

    it('rejects a path that is not in the workspace mirror', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/link')(linkBody({ filePath: 'docs/missing.md' }), res);

      expect(res.statusCode).toBe(404);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('refuses to link a trashed document', async () => {
      mockGetDocMeta.mockResolvedValue({ fileId: 'file-a', trashed: true });
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/link')(linkBody(), res);

      expect(res.statusCode).toBe(400);
      expect(await store.getGoogleDocMapping('T1', 'docs/a.md')).toBeNull();
    });

    it('reports a document already linked elsewhere as a conflict', async () => {
      await store.setGoogleDocMapping('T1', 'docs/other.md', {
        fileId: 'file-a',
        webViewLink: 'https://example.com/a',
        linkedBy: 'U-manager',
        mode: 'replica',
      });
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/link')(linkBody(), res);

      expect(res.statusCode).toBe(409);
    });
  });

  describe('unlinking', () => {
    it('removes the mapping and its bookkeeping', async () => {
      await store.setGoogleDocMapping('T1', 'docs/a.md', {
        fileId: 'file-a',
        webViewLink: 'https://example.com/a',
        linkedBy: 'U-manager',
        mode: 'replica',
      });
      const route = collectRoutes();
      const res = makeRes();

      await route('delete', '/api/docs/:workspaceId/google/link')(
        { params: { workspaceId: 'T1' }, body: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.body).toEqual({ ok: true, removed: true });
      expect(await store.getGoogleDocMapping('T1', 'docs/a.md')).toBeNull();
    });
  });

  describe('review decisions', () => {
    beforeEach(() => {
      mockBuildReview.mockResolvedValue({ githubPath: 'docs/a.md', docUrl: 'https://example.com/a', status: 'ready' });
      mockApprove.mockResolvedValue({ outcome: 'committed', commitSha: 'abc' });
      mockReject.mockResolvedValue({ outcome: 'restored' });
    });

    it('returns the proposal for a manager', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('get', '/api/docs/:workspaceId/google/review')(
        { params: { workspaceId: 'T1' }, query: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'ready' });
    });

    it('refuses a review to a non-manager', async () => {
      const route = collectRoutes(false);
      const res = makeRes();

      await route('get', '/api/docs/:workspaceId/google/review')(
        { params: { workspaceId: 'T1' }, query: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(mockBuildReview).not.toHaveBeenCalled();
    });

    it('commits an approval as the signed-in manager', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/review/approve')(
        { params: { workspaceId: 'T1' }, body: { filePath: 'docs/a.md', content: '# Merged' } },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(mockApprove).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U-manager', content: '# Merged' }));
    });

    it('answers 409 when a fence refuses the decision', async () => {
      // The client must re-read the rebuilt review rather than retry the same
      // decision against a state that has moved on.
      mockApprove.mockResolvedValue({ outcome: 'stale' });
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/review/approve')(
        { params: { workspaceId: 'T1' }, body: { filePath: 'docs/a.md', content: 'x' } },
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ outcome: 'stale' });
    });

    it('requires content on approval so an empty body cannot blank a document', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/review/approve')(
        { params: { workspaceId: 'T1' }, body: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(mockApprove).not.toHaveBeenCalled();
    });

    it('restores the replica on rejection', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/review/reject')(
        { params: { workspaceId: 'T1' }, body: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(mockReject).toHaveBeenCalledWith('T1', 'docs/a.md');
    });

    it('refuses a rejection from another workspace', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('post', '/api/docs/:workspaceId/google/review/reject')(
        { params: { workspaceId: 'T2' }, body: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.statusCode).toBe(401);
      expect(mockReject).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('reports a workspace that has not connected an account', async () => {
      const route = collectRoutes();
      const res = makeRes();

      await route('get', '/api/docs/:workspaceId/google/status')({ params: { workspaceId: 'T1' }, query: {} }, res);

      expect(res.body).toMatchObject({ configured: true, connected: false, document: null, linkedCount: 0 });
    });

    it('reports the mapping for the document being viewed', async () => {
      await store.setGoogleAuth('T1', { refreshToken: 'rt', email: 'a@example.com', connectedBy: 'U-manager' });
      await store.setGoogleDocMapping('T1', 'docs/a.md', {
        fileId: 'file-a',
        webViewLink: 'https://example.com/a',
        linkedBy: 'U-manager',
        mode: 'replica',
      });
      const route = collectRoutes();
      const res = makeRes();

      await route('get', '/api/docs/:workspaceId/google/status')(
        { params: { workspaceId: 'T1' }, query: { filePath: 'docs/a.md' } },
        res,
      );

      expect(res.body).toMatchObject({
        connected: true,
        email: 'a@example.com',
        document: { fileId: 'file-a', status: 'synced' },
      });
    });

    it('reports a rejected credential so the viewer can prompt a reconnect', async () => {
      await store.setGoogleAuth('T1', { refreshToken: 'rt', connectedBy: 'U-manager' });
      await store.setGoogleAuthBroken('T1', true);
      const route = collectRoutes();
      const res = makeRes();

      await route('get', '/api/docs/:workspaceId/google/status')({ params: { workspaceId: 'T1' }, query: {} }, res);

      expect(res.body).toMatchObject({ connected: true, broken: true });
    });
  });
});
