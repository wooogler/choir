import { getDocsWriteAccess } from '../services/docs-editor/write-access';
import { commitGlossaryRows } from '../services/glossary/commit';
import { extractGlossaryCandidates } from '../services/glossary/extract';
import { loadGlossary } from '../services/glossary/load';
import { registerGlossaryRoutes } from '../services/glossary/routes';
import { getDraftStore } from '../services/import/draft-store';
import type { ConvertedDocument } from '../services/import/types';

/**
 * The HTTP surface of "build a glossary from these documents": the auth ladder,
 * what each route puts on the wire, and the three answers a manager is most
 * likely to meet — an expired preview, a document with no terms in it, and a
 * commit that landed. The extraction and the commit are mocked; each has its
 * own suite, and between them they reach OpenAI and GitHub.
 */

jest.mock('../services/glossary/extract', () => ({ extractGlossaryCandidates: jest.fn() }));
jest.mock('../services/glossary/commit', () => {
  // The route answers a refusal with its own status and code, so the class has
  // to be a real one `instanceof` recognises.
  class GlossaryRefusal extends Error {
    readonly status: number;
    readonly apiCode: string;
    readonly detail?: Record<string, string | number>;
    constructor(status: number, apiCode: string, detail?: Record<string, string | number>) {
      super(apiCode);
      this.name = 'GlossaryRefusal';
      this.status = status;
      this.apiCode = apiCode;
      this.detail = detail;
    }
  }
  return { commitGlossaryRows: jest.fn(), GlossaryRefusal };
});
jest.mock('../services/glossary/load', () => ({ loadGlossary: jest.fn() }));
jest.mock('../services/docs-editor/write-access', () => ({ getDocsWriteAccess: jest.fn() }));
jest.mock('../services/docs-editor/create-document', () => {
  class CreateDocumentRefusal extends Error {
    readonly status: number;
    readonly apiCode: string;
    constructor(status: number, apiCode: string) {
      super(apiCode);
      this.name = 'CreateDocumentRefusal';
      this.status = status;
      this.apiCode = apiCode;
    }
  }
  return { createDocument: jest.fn(), CreateDocumentRefusal };
});

const mockExtract = extractGlossaryCandidates as jest.MockedFunction<typeof extractGlossaryCandidates>;
const mockCommit = commitGlossaryRows as jest.MockedFunction<typeof commitGlossaryRows>;
const mockLoad = loadGlossary as jest.MockedFunction<typeof loadGlossary>;
const mockWriteAccess = getDocsWriteAccess as jest.MockedFunction<typeof getDocsWriteAccess>;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const MANAGER = { workspaceId: 'T1', userId: 'U-manager' };

let session: { workspaceId: string; userId: string } | null = MANAGER;
let managerResult = true;
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
      return res;
    },
  };
  return res;
}

function seedDocument(title: string): ConvertedDocument {
  return {
    markdown: `# ${title}\n\nRAG means Retrieval-Augmented Generation.\n`,
    title,
    assets: [],
    rejectedAssets: [],
    warnings: [],
    source: { kind: 'pdf', name: `${title}.pdf` },
  };
}

/** A real draft, because the 410 below is about a draft that is genuinely gone. */
function makeDraft(title: string, owner = MANAGER): string {
  return getDraftStore().create({ workspaceId: owner.workspaceId, userId: owner.userId, document: seedDocument(title) })
    .id;
}

const errorOf = (res: ReturnType<typeof makeRes>) => (res.body as { error: string }).error;

beforeAll(() => {
  registerGlossaryRoutes(
    {
      get: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'get', path: routePath, handler: rest[rest.length - 1] as Handler }),
      post: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'post', path: routePath, handler: rest[rest.length - 1] as Handler }),
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
  mockLoad.mockResolvedValue({ entries: [], files: [] });
});

afterAll(() => {
  getDraftStore().dispose();
});

describe('glossary routes: the auth ladder', () => {
  it('refuses a request with no session', async () => {
    session = null;
    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/glossary')(makeReq(), res);

    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe('not_signed_in');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('refuses a session belonging to another workspace', async () => {
    session = { workspaceId: 'T2', userId: 'U-manager' };
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(makeReq({ body: { folder: '' } }), res);

    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toBe('workspace_mismatch');
  });

  it('refuses a non-manager', async () => {
    managerResult = false;
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/commit')(makeReq({ body: { rows: [] } }), res);

    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toBe('not_a_manager');
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('refuses a manager whose GitHub account cannot push, on the read as well', async () => {
    mockWriteAccess.mockResolvedValue({
      connected: true,
      canPush: false,
      reason: 'github_repo_read_only',
      detail: { repo: 'acme/docs' },
    });

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/glossary')(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'github_repo_read_only', code: 'GITHUB_WRITE_FORBIDDEN' });
  });
});

describe('GET glossary', () => {
  it('answers with the chain governing the folder', async () => {
    mockLoad.mockResolvedValue({
      entries: [
        { term: 'CHOIR', aliases: ['코이어'], description: 'The bot', file: 'projects/alpha/GLOSSARY.md' },
        { term: 'QMD', aliases: [], description: 'The index', file: 'GLOSSARY.md' },
      ],
      files: ['projects/alpha/GLOSSARY.md', 'GLOSSARY.md'],
    });

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/glossary')(makeReq({ query: { folder: '/projects/alpha/' } }), res);

    expect(res.body).toEqual({
      folder: 'projects/alpha',
      files: ['projects/alpha/GLOSSARY.md', 'GLOSSARY.md'],
      entries: 2,
      nearestFile: 'projects/alpha/GLOSSARY.md',
    });
    // A folder is read as a folder, not as a document called `alpha`.
    expect(mockLoad).toHaveBeenCalledWith('T1', 'projects/alpha/');
  });

  it('answers for a folder with no glossary at all', async () => {
    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/glossary')(makeReq(), res);

    expect(res.body).toEqual({ folder: '', files: [], entries: 0, nearestFile: null });
    expect(mockLoad).toHaveBeenCalledWith('T1', '');
  });
});

describe('POST glossary/extract', () => {
  it('reads the drafts, runs the extraction against the chain, and answers with candidates', async () => {
    const first = makeDraft('Attention is all you need');
    const second = makeDraft('CHOIR handbook');
    mockLoad.mockResolvedValue({
      entries: [{ term: 'CHOIR', aliases: [], description: 'The bot', file: 'GLOSSARY.md' }],
      files: ['GLOSSARY.md'],
    });
    mockExtract.mockResolvedValue([
      {
        term: 'RAG',
        aliases: ['Retrieval-Augmented Generation'],
        description: 'Retrieval then generation',
        kind: 'acronym',
      },
    ]);

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(
      makeReq({ body: { folder: 'meetings', draftIds: [first, second], language: 'ko' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ existing: 1, nearestFile: 'GLOSSARY.md' });
    expect((res.body as { candidates: unknown[] }).candidates).toHaveLength(1);

    const call = mockExtract.mock.calls[0][0];
    expect(call.workspaceId).toBe('T1');
    expect(call.language).toBe('ko');
    expect(call.existing).toHaveLength(1);
    // Both seed documents, each under its own title, so a candidate can be
    // credited to the document it came from.
    expect(call.markdown).toContain('# Attention is all you need');
    expect(call.markdown).toContain('# CHOIR handbook');
  });

  it('answers 410 when a draft has expired, and extracts nothing', async () => {
    const live = makeDraft('Still here');

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(
      makeReq({ body: { folder: '', draftIds: [live, 'gone-for-good'] } }),
      res,
    );

    expect(res.statusCode).toBe(410);
    expect(errorOf(res)).toBe('import_draft_expired');
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('answers 410 for somebody else’s draft, and for no drafts at all', async () => {
    const theirs = makeDraft('Not yours', { workspaceId: 'T1', userId: 'U-other' });

    const stolen = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(
      makeReq({ body: { folder: '', draftIds: [theirs] } }),
      stolen,
    );
    expect(stolen.statusCode).toBe(410);

    const empty = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(makeReq({ body: { folder: '' } }), empty);
    expect(empty.statusCode).toBe(410);
  });

  it('answers 422 when the document defined nothing worth keeping', async () => {
    const draft = makeDraft('A page of prose');
    mockExtract.mockResolvedValue([]);

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(
      makeReq({ body: { folder: '', draftIds: [draft] } }),
      res,
    );

    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toBe('glossary_no_terms');
  });

  it('refuses a language the glossary template has no headers for', async () => {
    const draft = makeDraft('Paper');

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(
      makeReq({ body: { folder: '', draftIds: [draft], language: 'fr' } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toBe('invalid_language');
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('answers 500 for a fault of ours', async () => {
    const draft = makeDraft('Paper');
    mockExtract.mockRejectedValue(new Error('the model hung up'));

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/extract')(
      makeReq({ body: { folder: '', draftIds: [draft] } }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toBe('internal_error');
  });
});

describe('POST glossary/commit', () => {
  it('commits the rows the manager kept', async () => {
    mockCommit.mockResolvedValue({
      path: 'meetings/GLOSSARY.md',
      commitSha: 'abc123',
      added: 2,
      skipped: ['CHOIR'],
      created: true,
    });

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/commit')(
      makeReq({
        body: {
          folder: 'meetings/',
          createAt: 'folder',
          fileName: 'TERMS.md',
          rows: [
            { term: 'RAG', aliases: ['래그', ''], description: 'Retrieval then generation' },
            { term: ' QMD ', description: 'The index' },
            { term: '   ', description: 'dropped: no term' },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      path: 'meetings/GLOSSARY.md',
      commitSha: 'abc123',
      added: 2,
      skipped: ['CHOIR'],
      created: true,
    });
    expect(mockCommit).toHaveBeenCalledWith({
      workspaceId: 'T1',
      userId: 'U-manager',
      folder: 'meetings',
      fileName: 'TERMS.md',
      createAt: 'folder',
      rows: [
        { term: 'RAG', aliases: ['래그'], description: 'Retrieval then generation' },
        { term: 'QMD', aliases: [], description: 'The index' },
      ],
    });
  });

  it('defaults to the nearest glossary when the dialog did not force a folder', async () => {
    mockCommit.mockResolvedValue({ path: 'GLOSSARY.md', commitSha: 'abc', added: 1, skipped: [], created: false });

    await route('post', '/api/docs/:workspaceId/glossary/commit')(
      makeReq({ body: { folder: 'projects/alpha', rows: [{ term: 'QMD', description: 'The index' }] } }),
      makeRes(),
    );

    expect(mockCommit.mock.calls[0][0]).toMatchObject({ createAt: 'nearest' });
    expect(mockCommit.mock.calls[0][0]).not.toHaveProperty('fileName');
  });

  it('refuses a request with no usable rows without reaching the commit', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/commit')(
      makeReq({ body: { folder: '', rows: [{ description: 'no term' }] } }),
      res,
    );

    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toBe('glossary_no_terms');
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('passes a refusal through with its own status and code', async () => {
    const { GlossaryRefusal } = jest.requireMock('../services/glossary/commit') as {
      GlossaryRefusal: new (status: number, apiCode: string, detail?: Record<string, string>) => Error;
    };
    mockCommit.mockRejectedValue(new GlossaryRefusal(400, 'glossary_file_invalid', { path: 'assets/GLOSSARY.md' }));

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/glossary/commit')(
      makeReq({ body: { folder: 'assets', rows: [{ term: 'QMD', description: 'The index' }] } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'glossary_file_invalid', detail: { path: 'assets/GLOSSARY.md' } });
  });
});
