import { CreateDocumentRefusal, createDocument } from 'services/docs-editor/create-document';
import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { getDraftStore } from 'services/import/draft-store';
import { registerImportRoutes } from 'services/import/routes';
import { SOURCE_NOTE_MARKER } from 'services/import/source-note';
import { convertPdf, estimatePdfImport, inspectPdf, planPdfImport } from 'services/import/sources/pdf';
import { convertUrl } from 'services/import/sources/web';
import type { ConvertedDocument, ImportProgressListener } from 'services/import/types';
import { ImportRefusal } from 'services/import/types';
import { getUploadStore } from 'services/import/upload-store';

/**
 * The HTTP surface of import: the auth ladder, what each route puts on the wire,
 * and the three refusals a manager is most likely to meet (busy, expired, taken
 * path). The conversions themselves are mocked — each has its own suite, and
 * between them they pull pdfjs, JSDOM and the GitHub client into a process jest
 * would rather not load.
 */

jest.mock('services/import/sources/web', () => ({ convertUrl: jest.fn() }));
jest.mock('services/import/sources/pdf', () => ({
  convertPdf: jest.fn(),
  inspectPdf: jest.fn(),
  planPdfImport: jest.fn(),
  estimatePdfImport: jest.fn(),
}));
jest.mock('services/docs-editor/create-document', () => {
  // The route answers a refusal with its own status and code, so the class has
  // to be a real one `instanceof` recognises.
  class CreateDocumentRefusal extends Error {
    readonly status: number;
    readonly apiCode: string;
    readonly detail?: Record<string, string | number>;
    constructor(status: number, apiCode: string, detail?: Record<string, string | number>) {
      super(apiCode);
      this.name = 'CreateDocumentRefusal';
      this.status = status;
      this.apiCode = apiCode;
      this.detail = detail;
    }
  }
  return { createDocument: jest.fn(), CreateDocumentRefusal };
});
jest.mock('services/docs-editor/write-access', () => ({ getDocsWriteAccess: jest.fn() }));
// Reached only for the workspace's OpenAI key and the document's language; both
// answers are configuration, and neither is what these tests are about.
jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: class {
    async getOpenAISettings() {
      return undefined;
    }
  },
}));
jest.mock('services/i18n/resolve-locale', () => ({ resolveContentLanguage: jest.fn(async () => 'en') }));

const mockConvertUrl = convertUrl as jest.MockedFunction<typeof convertUrl>;
const mockConvertPdf = convertPdf as jest.MockedFunction<typeof convertPdf>;
const mockInspect = inspectPdf as jest.MockedFunction<typeof inspectPdf>;
const mockPlan = planPdfImport as jest.MockedFunction<typeof planPdfImport>;
const mockEstimate = estimatePdfImport as jest.MockedFunction<typeof estimatePdfImport>;
const mockCreateDocument = createDocument as jest.MockedFunction<typeof createDocument>;
const mockWriteAccess = getDocsWriteAccess as jest.MockedFunction<typeof getDocsWriteAccess>;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

interface Captured {
  method: string;
  path: string;
  handler: Handler;
}

const MANAGER = { workspaceId: 'T1', userId: 'U-manager' };

let session: { workspaceId: string; userId: string } | null = MANAGER;
let managerResult = true;
const routes: Captured[] = [];

/** Collects the registered handlers so they can be invoked without a server. */
function route(method: string, routePath: string): Handler {
  const found = routes.find((entry) => entry.method === method && entry.path === routePath);
  if (!found) throw new Error(`No ${method} ${routePath} registered`);
  return found.handler;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: { workspaceId: 'T1' },
    query: {},
    headers: {},
    ...overrides,
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string | string[]>,
    written: [] as string[],
    ended: false,
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

const NDJSON = { accept: 'application/x-ndjson' };

function urlDocument(overrides: Partial<ConvertedDocument> = {}): ConvertedDocument {
  return {
    markdown: '# Release notes\n\n![shot](assets/aaa.png)\n',
    title: 'Release notes',
    assets: [
      { path: 'assets/aaa.png', bytes: Buffer.from('first-image'), contentType: 'image/png' },
      { path: 'assets/bbb.png', bytes: Buffer.from('second-image'), contentType: 'image/png' },
    ],
    rejectedAssets: [],
    warnings: [],
    source: { kind: 'url', name: 'Release notes', url: 'https://example.com/notes' },
    ...overrides,
  };
}

/** Lets the event loop run so a handler awaiting its mocks reaches the lock. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

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
      readSession: async () => session,
      isManager: async () => managerResult,
      jsonBody: (_req: unknown, _res: unknown, next: () => void) => next(),
      rawPdfBody: (_req: unknown, _res: unknown, next: () => void) => next(),
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

afterAll(() => {
  getDraftStore().dispose();
  getUploadStore().dispose();
});

describe('import routes: the auth ladder', () => {
  it('refuses a request with no session', async () => {
    session = null;
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://x.test' } }), res);

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('not_signed_in');
    expect(mockConvertUrl).not.toHaveBeenCalled();
  });

  it('refuses a session belonging to another workspace', async () => {
    session = { workspaceId: 'T2', userId: 'U-manager' };
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://x.test' } }), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe('workspace_mismatch');
  });

  it('refuses a non-manager', async () => {
    managerResult = false;
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://x.test' } }), res);

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
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://x.test' } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'github_repo_read_only', code: 'GITHUB_WRITE_FORBIDDEN' });
    expect(mockConvertUrl).not.toHaveBeenCalled();
  });

  it('reports the same ladder as one boolean on status, without refusing', async () => {
    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/import/status')(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ canImport: true });
    expect((res.body as { pdf: { maxPages: number } }).pdf.maxPages).toBeGreaterThan(0);

    managerResult = false;
    const denied = makeRes();
    await route('get', '/api/docs/:workspaceId/import/status')(makeReq(), denied);
    expect(denied.statusCode).toBe(200);
    expect(denied.body).toMatchObject({ canImport: false });
  });
});

describe('POST import/url', () => {
  it('streams progress and ends with the draft', async () => {
    mockConvertUrl.mockImplementation(async (_url: string, opts: { onProgress?: ImportProgressListener } = {}) => {
      opts.onProgress?.({ step: 'fetching', label: 'Fetching the page' });
      opts.onProgress?.({ step: 'converting', label: 'Converting to markdown' });
      return urlDocument();
    });

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(
      makeReq({ headers: NDJSON, body: { url: 'https://example.com/notes' } }),
      res,
    );

    const lines = res.lines();
    expect(lines.slice(0, 2)).toMatchObject([
      { type: 'progress', step: 'fetching', index: 2, total: 4 },
      { type: 'progress', step: 'converting', index: 3, total: 4 },
    ]);

    const result = lines[lines.length - 1] as Record<string, unknown>;
    expect(result.type).toBe('result');
    expect(result.suggestedPath).toBe('release-notes.md');
    expect(result.title).toBe('Release notes');
    // Sizes, not Buffers: the bytes stay on the server behind the asset route.
    expect(result.assets).toEqual([
      { path: 'assets/aaa.png', bytes: 11, contentType: 'image/png' },
      { path: 'assets/bbb.png', bytes: 12, contentType: 'image/png' },
    ]);
    expect(typeof result.draftId).toBe('string');
    expect(res.headers['Content-Type']).toBe('application/x-ndjson; charset=utf-8');

    getDraftStore().delete(String(result.draftId), MANAGER);
  });

  it('answers plain JSON when the client did not ask for a stream', async () => {
    mockConvertUrl.mockResolvedValue(urlDocument());

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://x.test' } }), res);

    expect(res.written).toHaveLength(0);
    expect(res.body).toMatchObject({ title: 'Release notes' });
    getDraftStore().delete(String((res.body as { draftId: string }).draftId), MANAGER);
  });

  it('refuses a request with no URL', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: {} }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('import_url_invalid');
  });

  it('refuses a second conversion while one is running', async () => {
    let release: (() => void) | undefined;
    mockConvertUrl.mockImplementationOnce(
      () =>
        new Promise<ConvertedDocument>((resolve) => {
          release = () => resolve(urlDocument());
        }),
    );

    const first = route('post', '/api/docs/:workspaceId/import/url')(
      makeReq({ body: { url: 'https://slow.test' } }),
      makeRes(),
    );
    await settle();

    const busy = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://other.test' } }), busy);

    expect(busy.statusCode).toBe(409);
    expect((busy.body as { error: string }).error).toBe('import_busy');
    // A 409 rather than a stream line: nothing was written before the refusal.
    expect(busy.written).toHaveLength(0);

    release?.();
    await first;
  });

  it('passes a source refusal through with its own status and code', async () => {
    mockConvertUrl.mockRejectedValue(new ImportRefusal(422, 'import_url_unreadable'));

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://spa.test' } }), res);

    expect(res.statusCode).toBe(422);
    expect((res.body as { error: string }).error).toBe('import_url_unreadable');
  });

  it('reports an unexpected failure as a conversion failure', async () => {
    mockConvertUrl.mockRejectedValue(new Error('socket hang up'));

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/url')(makeReq({ body: { url: 'https://x.test' } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'import_conversion_failed', detail: { message: 'socket hang up' } });
  });
});

describe('POST import/pdf', () => {
  const inspection = { pages: 12, scannedPages: [], textPages: [1], pageTexts: [], title: 'Handbook' };
  const plan = { chunks: [{ from: 1, to: 12, detail: 'low' }], scannedPages: [] };
  const estimate = {
    pages: 12,
    scannedPages: 0,
    chunks: 1,
    inputTokens: 18_000,
    estimatedOutputTokens: 9_000,
    estimatedUsd: 0.05,
    model: 'gpt-5.4-mini',
    serviceTier: 'flex',
  };

  beforeEach(() => {
    mockInspect.mockResolvedValue(inspection as never);
    mockPlan.mockReturnValue(plan as never);
    mockEstimate.mockResolvedValue(estimate as never);
  });

  it('parks the upload and answers with the estimate', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf')(
      makeReq({
        headers: { 'x-import-filename': encodeURIComponent('사원 안내서.pdf') },
        body: Buffer.from('%PDF-1.7 ...'),
      }),
      res,
    );

    expect(res.body).toMatchObject({
      filename: '사원 안내서.pdf',
      estimate: { inputTokens: 18_000, model: 'gpt-5.4-mini', maxInputTokens: 400_000 },
    });
    expect(typeof (res.body as { uploadId: string }).uploadId).toBe('string');
    // Parked, not converted: the model is asked only on the convert call.
    expect(mockConvertPdf).not.toHaveBeenCalled();

    getUploadStore().delete(String((res.body as { uploadId: string }).uploadId), MANAGER);
  });

  it('takes the last segment of a filename and falls back when there is none', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf')(
      makeReq({
        headers: { 'x-import-filename': encodeURIComponent('C:\\Users\\me\\Docs\\report.pdf') },
        body: Buffer.from('%PDF'),
      }),
      res,
    );
    expect(res.body).toMatchObject({ filename: 'report.pdf' });
    getUploadStore().delete(String((res.body as { uploadId: string }).uploadId), MANAGER);

    const unnamed = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf')(makeReq({ body: Buffer.from('%PDF') }), unnamed);
    expect(unnamed.body).toMatchObject({ filename: 'document.pdf' });
    getUploadStore().delete(String((unnamed.body as { uploadId: string }).uploadId), MANAGER);
  });

  it('refuses a body that is not a PDF', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf')(makeReq({ body: {} }), res);

    expect(res.statusCode).toBe(415);
    expect((res.body as { error: string }).error).toBe('import_unsupported_file');
  });

  it('passes an estimate refusal through with its detail', async () => {
    mockEstimate.mockRejectedValue(
      new ImportRefusal(413, 'import_too_many_tokens', { inputTokens: 900_000, max: 400_000 }),
    );

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf')(makeReq({ body: Buffer.from('%PDF') }), res);

    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({
      error: 'import_too_many_tokens',
      detail: { inputTokens: 900_000, max: 400_000 },
    });
  });

  it('never lets a refusal code the API does not know escape', async () => {
    mockInspect.mockRejectedValue(new ImportRefusal(422, 'pdf_is_haunted'));

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf')(makeReq({ body: Buffer.from('%PDF') }), res);

    expect(res.statusCode).toBe(422);
    expect((res.body as { error: string }).error).toBe('import_conversion_failed');
  });
});

describe('POST import/pdf/:uploadId/convert', () => {
  it('refuses an upload id that is unknown, expired or somebody else’s', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf/:uploadId/convert')(
      makeReq({ params: { workspaceId: 'T1', uploadId: 'no-such-upload' } }),
      res,
    );

    expect(res.statusCode).toBe(410);
    expect((res.body as { error: string }).error).toBe('import_draft_expired');
    expect(mockConvertPdf).not.toHaveBeenCalled();
  });

  it('converts a parked upload into a draft and drops the upload', async () => {
    const upload = getUploadStore().create({
      ...MANAGER,
      bytes: Buffer.from('%PDF'),
      filename: 'handbook.pdf',
      inspection: { pages: 3 } as never,
      plan: { chunks: [] } as never,
      estimate: { pages: 3 } as never,
    });

    mockConvertPdf.mockImplementation(async ({ onProgress }) => {
      onProgress?.({ step: 'converting', label: 'Transcribing 1–3', current: 1, total: 2 });
      return {
        markdown: '# Handbook\n\nBody.\n',
        title: 'Handbook',
        assets: [],
        rejectedAssets: [],
        warnings: [{ code: 'scanned_pages', detail: { count: 2 } }],
        source: { kind: 'pdf', name: 'handbook.pdf', pages: 3 },
      };
    });

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/pdf/:uploadId/convert')(
      makeReq({ headers: NDJSON, params: { workspaceId: 'T1', uploadId: upload.id } }),
      res,
    );

    const lines = res.lines();
    expect(lines[0]).toMatchObject({ type: 'progress', step: 'converting', chunk: { current: 1, total: 2 } });

    const result = lines[lines.length - 1];
    expect(result).toMatchObject({
      type: 'result',
      title: 'Handbook',
      suggestedPath: 'handbook.md',
      warnings: [{ code: 'scanned_pages', detail: { count: 2 } }],
    });
    // The bytes have done their job; a retry must re-estimate rather than
    // silently spend the workspace's key on them again.
    expect(getUploadStore().get(upload.id, MANAGER)).toBeNull();

    getDraftStore().delete(String((result as { draftId: string }).draftId), MANAGER);
  });
});

describe('POST import/commit', () => {
  const draftFor = (document = urlDocument()) => getDraftStore().create({ ...MANAGER, document });

  beforeEach(() => {
    // The landing site drives the commit progress bar, so the mock reports the
    // way it does: the route only forwards what it is told.
    mockCreateDocument.mockImplementation(async ({ onStep }) => {
      onStep?.('checking');
      onStep?.('committing');
      onStep?.('done');
      return { commitSha: 'abc123', filePath: 'docs/release-notes.md' };
    });
  });

  it('prepends the source note, commits only referenced assets, and drops the draft', async () => {
    const draft = draftFor();

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/commit')(
      makeReq({
        headers: NDJSON,
        body: {
          draftId: draft.id,
          filePath: 'docs/release-notes.md',
          markdown: '# Release notes\n\n![shot](assets/aaa.png)\n',
        },
      }),
      res,
    );

    const params = mockCreateDocument.mock.calls[0][0];
    expect(params.content).toContain(SOURCE_NOTE_MARKER);
    expect(params.content).toContain('https://example.com/notes');
    // The note sits under the title, not above it.
    expect(params.content?.split('\n')[0]).toBe('# Release notes');
    // `assets/bbb.png` is in the draft but not in the body, so it is not committed.
    expect(params.assets?.map((asset) => asset.path)).toEqual(['assets/aaa.png']);
    expect(params.commitMessage).toBe('Import release-notes.md from example.com');
    expect(params.source).toMatchObject({ import: 'url', url: 'https://example.com/notes' });

    const lines = res.lines();
    expect(lines.some((line) => line.type === 'progress' && line.step === 'committing')).toBe(true);
    expect(lines[lines.length - 1]).toMatchObject({
      type: 'result',
      githubPath: 'docs/release-notes.md',
      commitSha: 'abc123',
      droppedReferences: [],
    });

    expect(getDraftStore().get(draft.id, MANAGER)).toBeNull();
  });

  it('reports references the draft does not back', async () => {
    const draft = draftFor();

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/commit')(
      makeReq({
        body: {
          draftId: draft.id,
          filePath: 'docs/release-notes.md',
          markdown: '# Release notes\n\n![gone](assets/zzz.png)\n',
        },
      }),
      res,
    );

    expect(res.body).toMatchObject({ droppedReferences: ['assets/zzz.png'] });
    expect(mockCreateDocument.mock.calls[0][0].assets).toEqual([]);
  });

  it('refuses an expired, unknown or foreign draft', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/commit')(
      makeReq({ body: { draftId: 'gone', filePath: 'docs/a.md', markdown: '# A\n' } }),
      res,
    );

    expect(res.statusCode).toBe(410);
    expect((res.body as { error: string }).error).toBe('import_draft_expired');
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('answers an occupied path with the landing refusal', async () => {
    const draft = draftFor();
    mockCreateDocument.mockRejectedValue(new CreateDocumentRefusal(409, 'document_exists', { path: 'docs/a.md' }));

    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/commit')(
      makeReq({ body: { draftId: draft.id, filePath: 'docs/a.md', markdown: '# A\n' } }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'document_exists', detail: { path: 'docs/a.md' } });
    // The draft survives a refused commit: the manager fixes the path and retries.
    expect(getDraftStore().get(draft.id, MANAGER)).not.toBeNull();
    getDraftStore().delete(draft.id, MANAGER);
  });

  it('requires a path', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/commit')(makeReq({ body: { draftId: 'x' } }), res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('file_path_required');
  });
});

describe('draft assets and disposal', () => {
  it('serves an image out of the caller’s own draft', async () => {
    const draft = getDraftStore().create({ ...MANAGER, document: urlDocument() });

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/import/draft/:draftId/asset/*assetPath')(
      makeReq({ params: { workspaceId: 'T1', draftId: draft.id, assetPath: ['assets', 'aaa.png'] } }),
      res,
    );

    expect(res.body).toEqual(Buffer.from('first-image'));
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Cache-Control']).toBe('private, max-age=600');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');

    getDraftStore().delete(draft.id, MANAGER);
  });

  it('will not serve another manager’s draft', async () => {
    const draft = getDraftStore().create({ ...MANAGER, document: urlDocument() });
    session = { workspaceId: 'T1', userId: 'U-other' };

    const res = makeRes();
    await route('get', '/api/docs/:workspaceId/import/draft/:draftId/asset/*assetPath')(
      makeReq({ params: { workspaceId: 'T1', draftId: draft.id, assetPath: ['assets', 'aaa.png'] } }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toBe('document_not_found');

    session = MANAGER;
    getDraftStore().delete(draft.id, MANAGER);
  });

  it('answers 204 whether or not the draft was there', async () => {
    const draft = getDraftStore().create({ ...MANAGER, document: urlDocument() });

    const res = makeRes();
    await route('delete', '/api/docs/:workspaceId/import/draft/:draftId')(
      makeReq({ params: { workspaceId: 'T1', draftId: draft.id } }),
      res,
    );
    expect(res.statusCode).toBe(204);
    expect(getDraftStore().get(draft.id, MANAGER)).toBeNull();

    const again = makeRes();
    await route('delete', '/api/docs/:workspaceId/import/draft/:draftId')(
      makeReq({ params: { workspaceId: 'T1', draftId: 'never-existed' } }),
      again,
    );
    expect(again.statusCode).toBe(204);
  });
});
