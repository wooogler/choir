import { createDocument } from 'services/docs-editor/create-document';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { glossaryFileFor } from 'services/glossary/load';
import { getDraftStore } from 'services/import/draft-store';
import { registerImportRoutes } from 'services/import/routes';
import type { ConvertedDocument } from 'services/import/types';

/**
 * Committing an imported document and the terms it taught, in one commit.
 *
 * The rule under test is the loop from docs/meeting-notes-and-glossary.md,
 * 용어집 §5: the rows a manager ticked in the preview become a companion edit
 * on the nearest `GLOSSARY.md` (or the folder's first one), and that file rides
 * in the same `createDocument` call as the document. What the landing then does
 * with a companion has its own suite (document-creation); here the questions
 * are which file the rows land in, what the response says, and which malformed
 * request is a refusal rather than an empty set.
 */

jest.mock('services/import/sources/web', () => ({ convertUrl: jest.fn() }));
jest.mock('services/import/sources/pdf', () => ({
  convertPdf: jest.fn(),
  inspectPdf: jest.fn(),
  planPdfImport: jest.fn(),
  estimatePdfImport: jest.fn(),
}));
jest.mock('services/docs-editor/create-document', () => {
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
jest.mock('services/docs-editor/write-access', () => ({ getDocsWriteAccess: jest.fn() }));
jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: class {
    async getOpenAISettings() {
      return undefined;
    }
  },
}));
jest.mock('services/i18n/resolve-locale', () => ({ resolveContentLanguage: jest.fn(async () => 'en') }));

// Which glossary governs the folder is a filesystem walk of its own (its suite
// is glossary-load); here it is the input the companion builder reacts to.
jest.mock('services/glossary/load', () => ({
  ...jest.requireActual('services/glossary/load'),
  glossaryFileFor: jest.fn(),
}));

/** What the mirror holds, keyed by repository path. */
let mirror: Record<string, string> = {};
let mirrorError: Error | null = null;

jest.mock('services/workspace/mirror-service', () => ({
  WorkspaceMirrorService: {
    getInstance: () => ({
      readMirrorFile: async (_workspaceId: string, filePath: string) => {
        if (mirrorError) throw mirrorError;
        return mirror[filePath] ?? null;
      },
      getRepoRoot: () => '/tmp/choir-companion-mirror',
    }),
  },
}));

const mockCreateDocument = createDocument as jest.MockedFunction<typeof createDocument>;
const mockWriteAccess = getDocsWriteAccess as jest.MockedFunction<typeof getDocsWriteAccess>;
const mockNearest = glossaryFileFor as jest.MockedFunction<typeof glossaryFileFor>;

const MANAGER = { workspaceId: 'T1', userId: 'U-manager' };

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const routes: Array<{ method: string; path: string; handler: Handler }> = [];

function route(method: string, routePath: string): Handler {
  const found = routes.find((entry) => entry.method === method && entry.path === routePath);
  if (!found) throw new Error(`No ${method} ${routePath} registered`);
  return found.handler;
}

function makeReq(body: Record<string, unknown>) {
  return { params: { workspaceId: 'T1' }, query: {}, headers: {}, body };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string | string[]>,
    written: [] as string[],
    headersSent: false,
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
    setHeader(name: string, value: string | string[]) {
      res.headers[name] = value;
    },
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
      return res;
    },
  };
  return res;
}

const EXISTING_GLOSSARY = [
  '# Glossary',
  '',
  '| Term | Also known as | Description |',
  '| --- | --- | --- |',
  '| CHOIR | choir | the Slack knowledge bot |',
  '',
].join('\n');

function meetingDocument(): ConvertedDocument {
  return {
    markdown: '# Weekly sync\n\nWe talked about QMD.\n',
    title: 'Weekly sync',
    assets: [],
    rejectedAssets: [],
    warnings: [],
    source: { kind: 'meeting', name: 'weekly.vtt' },
  };
}

const ROWS = [{ term: 'QMD', aliases: ['qmd'], description: 'the local search index' }];

/** Posts a commit for `meetings/2026-09-20-weekly.md` with whatever glossary body. */
async function commit(glossary: unknown, overrides: Record<string, unknown> = {}) {
  const draft = getDraftStore().create({ ...MANAGER, document: meetingDocument() });
  const res = makeRes();
  await route('post', '/api/docs/:workspaceId/import/commit')(
    makeReq({
      draftId: draft.id,
      filePath: 'meetings/2026-09-20-weekly.md',
      markdown: '# Weekly sync\n\nWe talked about QMD.\n',
      ...(glossary === undefined ? {} : { glossary }),
      ...overrides,
    }),
    res,
  );
  getDraftStore().delete(draft.id, MANAGER);
  return res;
}

/** The companion `createDocument` was asked to commit, if any. */
function companion(): { path: string; content: string } | undefined {
  return mockCreateDocument.mock.calls[0]?.[0].companionEdits?.[0];
}

beforeAll(() => {
  registerImportRoutes(
    {
      get: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'get', path: routePath, handler: rest[rest.length - 1] as Handler }),
      post: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'post', path: routePath, handler: rest[rest.length - 1] as Handler }),
      delete: (routePath: string, ...rest: unknown[]) =>
        routes.push({ method: 'delete', path: routePath, handler: rest[rest.length - 1] as Handler }),
    } as never,
    {
      readSession: async () => MANAGER,
      isManager: async () => true,
      jsonBody: (_req: unknown, _res: unknown, next: () => void) => next(),
      rawPdfBody: (_req: unknown, _res: unknown, next: () => void) => next(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never,
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  mirror = {};
  mirrorError = null;
  mockNearest.mockResolvedValue(null);
  mockWriteAccess.mockResolvedValue({ connected: true, canPush: true, repo: 'acme/docs' });
  mockCreateDocument.mockResolvedValue({ commitSha: 'abc123', filePath: 'meetings/2026-09-20-weekly.md' });
});

afterAll(() => {
  getDraftStore().dispose();
});

describe('POST import/commit: the glossary rides along', () => {
  it('appends the rows to the nearest glossary, in the same commit', async () => {
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    const res = await commit({ rows: ROWS });

    // One commit, two files: the document is the landing's business, the rows
    // travel as the companion.
    expect(companion()?.path).toBe('GLOSSARY.md');
    expect(companion()?.content).toContain('| QMD | qmd | the local search index |');
    // Everything that was already in the file is still in it.
    expect(companion()?.content).toContain('| CHOIR | choir | the Slack knowledge bot |');

    expect(res.body).toMatchObject({
      githubPath: 'meetings/2026-09-20-weekly.md',
      commitSha: 'abc123',
      glossary: { path: 'GLOSSARY.md', added: 1, skipped: [], created: false },
    });
  });

  it('writes the folder its first glossary when the chain has none', async () => {
    const res = await commit({ rows: ROWS });

    expect(companion()?.path).toBe('meetings/GLOSSARY.md');
    // The template, in the document's language, with the row already in it.
    expect(companion()?.content).toBe(
      [
        '# Glossary',
        '',
        '| Term | Also known as | Description |',
        '| --- | --- | --- |',
        '| QMD | qmd | the local search index |',
        '',
      ].join('\n'),
    );
    expect(res.body).toMatchObject({ glossary: { path: 'meetings/GLOSSARY.md', added: 1, created: true } });
  });

  it('keeps a team’s own glossary out of the organization’s, when asked', async () => {
    // `createAt: 'folder'` is the escape hatch: the root glossary got there
    // first, and these terms belong to this folder.
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    await commit({ rows: ROWS, createAt: 'folder' });

    expect(companion()?.path).toBe('meetings/GLOSSARY.md');
    expect(companion()?.content).not.toContain('the Slack knowledge bot');
  });

  it('honours a workspace’s own glossary filename for a file it creates', async () => {
    await commit({ rows: ROWS, fileName: 'TERMS.md' });

    expect(companion()?.path).toBe('meetings/TERMS.md');
    expect(mockNearest).toHaveBeenCalledWith('T1', 'meetings', { fileName: 'TERMS.md' });
  });

  it('commits no companion when every row is already there', async () => {
    mockNearest.mockResolvedValue('meetings/GLOSSARY.md');
    mirror['meetings/GLOSSARY.md'] = [EXISTING_GLOSSARY.trimEnd(), '| QMD | qmd | the local search index |', ''].join(
      '\n',
    );

    const res = await commit({ rows: [...ROWS, { term: '  ', aliases: [], description: 'blank' }] });

    // A duplicate is not an error — the loop proposes the same term sooner or
    // later — but an empty diff with a commit message about terms would be.
    expect(mockCreateDocument.mock.calls[0][0].companionEdits).toBeUndefined();
    expect(res.body).toMatchObject({ commitSha: 'abc123', glossary: null });
  });

  it('says nothing about a glossary when the body asked for none', async () => {
    const res = await commit(undefined);

    expect(mockCreateDocument.mock.calls[0][0].companionEdits).toBeUndefined();
    expect(res.body).toMatchObject({ glossary: null });
  });

  it('reports the terms it skipped beside the ones it added', async () => {
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    const res = await commit({ rows: [{ term: 'CHOIR', aliases: [], description: 'again' }, ...ROWS] });

    expect(res.body).toMatchObject({ glossary: { added: 1, skipped: ['CHOIR'] } });
    expect(companion()?.content).toContain('| QMD |');
  });

  it('commits nothing at all when the mirror cannot be read', async () => {
    // The companion replaces the glossary wholesale, so appending to content we
    // could not read would drop every term the folder already had.
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirrorError = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    const res = await commit({ rows: ROWS });

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe('import_conversion_failed');
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('refuses a malformed rows array rather than committing without it', async () => {
    // Read as "no terms", this would commit the document and silently lose
    // every term the manager ticked.
    for (const glossary of [{ rows: 'QMD' }, { rows: ['QMD'] }, { rows: [{ aliases: [], description: 'x' }] }, []]) {
      const res = await commit(glossary);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ error: 'glossary_no_terms' });
      expect((res.body as { detail?: { message?: string } }).detail?.message).toBeDefined();
      expect(mockCreateDocument).not.toHaveBeenCalled();
    }
  });

  it('refuses a filename that is not a glossary basename', async () => {
    for (const fileName of ['../../etc/passwd.md', 'notes.txt', '   ']) {
      const res = await commit({ rows: ROWS, fileName });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ error: 'glossary_file_invalid' });
      expect(mockCreateDocument).not.toHaveBeenCalled();
    }
  });
});
