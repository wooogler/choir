import { getDocsWriteAccess } from 'services/docs-editor/write-access';
import { getDraftStore } from 'services/import/draft-store';
import { registerMeetingRoutes } from 'services/import/meeting-routes';
import { convertMeeting, getMeetingUploadStore } from 'services/import/sources/meeting';

/**
 * The HTTP surface of "회의록 만들기": the auth ladder, what lands on the wire,
 * and the refusals a manager is most likely to meet. Only the conversion is
 * mocked — the parsing, the meta check, the estimate and the upload store are
 * the real ones, because the shape of this route is exactly how they fit
 * together. The glossary and the project index are stubbed: both reach the
 * workspace mirror, which a route test has no business booting.
 */

jest.mock('services/import/sources/meeting', () => ({
  ...jest.requireActual('services/import/sources/meeting'),
  convertMeeting: jest.fn(),
}));
jest.mock('services/docs-editor/write-access', () => ({ getDocsWriteAccess: jest.fn() }));
jest.mock('services/glossary/load', () => ({ loadGlossary: jest.fn(async () => ({ entries: [], files: [] })) }));
jest.mock('services/projects/project-index', () => ({ resolveProjectForPath: jest.fn(async () => null) }));
jest.mock('services/llm/llm-config', () => ({
  resolveLLMConfig: jest.fn(async () => ({ apiKey: 'sk-test', model: 'gpt-5.4-mini', source: 'workspace' })),
}));

const mockConvert = convertMeeting as jest.MockedFunction<typeof convertMeeting>;
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

const META = {
  title: '주간 동기화 회의',
  date: '2026-09-20',
  folder: 'meetings',
  fileName: '2026-09-20-weekly.md',
  participants: ['이상욱', '김민지'],
  context: 'CHOIR 주간 회의',
  format: 'notes',
};

const ZOOM = `00:00:03 이상욱: 인덱스 재생성 이야기부터 하죠.
00:00:31 김민지: 어제 야간 재생성으로 바꿔서 올렸습니다.
00:01:02 이상욱: 스테이징에는 아직 예전 답이 나옵니다.
00:01:20 김민지: 캐시를 다시 데우겠습니다.
00:01:44 이상욱: 그러면 매일 밤에 도는 걸로 정하죠.
00:02:03 김민지: 문서에도 적어 두겠습니다.`;

const upload = (body: Record<string, unknown> = {}) =>
  route('post', '/api/docs/:workspaceId/import/meeting')(
    makeReq({ body: { text: ZOOM, meta: META, ...body } }),
    makeRes(),
  );

const convertedDocument = {
  markdown: '# 주간 동기화 회의\n\n## 전체 기록\n\n**이상욱**: …\n',
  title: '주간 동기화 회의',
  assets: [],
  rejectedAssets: [],
  warnings: [{ code: 'low_fidelity' as const, detail: { score: 0.71 } }],
  source: { kind: 'meeting' as const, name: 'weekly.txt', minutes: 2, speakers: 2 },
  unknownTerms: ['큐엠디'],
  speakerMap: { 이상욱: '이상욱' },
};

beforeAll(() => {
  registerMeetingRoutes(
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
  mockConvert.mockResolvedValue(convertedDocument);
});

afterAll(() => {
  getDraftStore().dispose();
  getMeetingUploadStore().dispose();
});

describe('the auth ladder', () => {
  it('refuses a request with no session', async () => {
    session = null;
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(makeReq({ body: { text: ZOOM, meta: META } }), res);

    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('not_signed_in');
  });

  it('refuses a session belonging to another workspace, and a non-manager', async () => {
    session = { workspaceId: 'T2', userId: 'U-manager' };
    const other = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(makeReq({ body: { meta: META } }), other);
    expect(other.statusCode).toBe(403);

    session = MANAGER;
    managerResult = false;
    const reader = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(makeReq({ body: { meta: META } }), reader);
    expect((reader.body as { error: string }).error).toBe('not_a_manager');
  });

  it('refuses a manager whose GitHub account cannot push, before parsing anything', async () => {
    mockWriteAccess.mockResolvedValue({
      connected: true,
      canPush: false,
      reason: 'github_repo_read_only',
      detail: { repo: 'acme/docs' },
    });
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(makeReq({ body: { text: ZOOM, meta: META } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'github_repo_read_only' });
  });
});

describe('POST import/meeting', () => {
  it('answers with what it read, what it will cost, and where it will land', async () => {
    const res = await upload();
    const body = res.body as Record<string, never>;

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      targetPath: 'meetings/2026-09-20-weekly.md',
      detected: { kind: 'transcript-text', speakers: ['이상욱', '김민지'], utterances: 6 },
    });
    expect(typeof body.uploadId).toBe('string');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.estimate).toMatchObject({ chunks: 1, model: 'gpt-5.4-mini' });
    expect((body.estimate as { inputTokens: number }).inputTokens).toBeGreaterThan(0);

    getMeetingUploadStore().delete(String(body.uploadId), MANAGER);
  });

  it('reads an uploaded file as well as a paste', async () => {
    const res = await route('post', '/api/docs/:workspaceId/import/meeting')(
      makeReq({
        body: {
          filename: 'weekly.vtt',
          contentBase64: Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:09.000\n<v 이상욱>안녕하세요.</v>').toString(
            'base64',
          ),
          meta: META,
        },
      }),
      makeRes(),
    );
    const body = res.body as Record<string, never>;

    expect(body.detected).toMatchObject({ kind: 'vtt', utterances: 1 });
    getMeetingUploadStore().delete(String(body.uploadId), MANAGER);
  });

  it('refuses meeting details a person can fix, with the sentence to show them', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(
      makeReq({ body: { text: ZOOM, meta: { ...META, folder: '../escape' } } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'meeting_meta_invalid' });
    expect(String((res.body as { message?: string }).message ?? '')).toMatch(/folder/i);
  });

  it('refuses an empty transcript', async () => {
    const empty = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(makeReq({ body: { meta: META } }), empty);
    expect(empty.statusCode).toBe(422);
    expect((empty.body as { error: string }).error).toBe('meeting_transcript_empty');

    const blank = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(
      makeReq({ body: { text: '   \n \n', meta: META } }),
      blank,
    );
    expect(blank.statusCode).toBe(422);
  });

  it('refuses a file it cannot open, by name', async () => {
    const res = makeRes();
    await route('post', '/api/docs/:workspaceId/import/meeting')(
      makeReq({ body: { filename: 'deck.pptx', contentBase64: Buffer.from('PK').toString('base64'), meta: META } }),
      res,
    );

    expect(res.statusCode).toBe(415);
    expect((res.body as { error: string }).error).toBe('import_unsupported_file');
  });
});

describe('POST import/meeting/:uploadId/convert', () => {
  const convertRoute = '/api/docs/:workspaceId/import/meeting/:uploadId/convert';

  async function uploadId(): Promise<string> {
    const res = await upload();
    return String((res.body as { uploadId: string }).uploadId);
  }

  it('streams progress and ends with a draft the commit route can take', async () => {
    mockConvert.mockImplementation(async (params) => {
      params.onProgress?.({ step: 'converting', label: 'Cleaning the transcript', current: 1, total: 1 });
      return convertedDocument;
    });

    const res = makeRes();
    await route('post', convertRoute)(
      makeReq({ headers: NDJSON, params: { workspaceId: 'T1', uploadId: await uploadId() } }),
      res,
    );

    const lines = res.lines();
    expect(lines[0]).toMatchObject({ type: 'progress', step: 'converting' });

    const result = lines[lines.length - 1];
    expect(result).toMatchObject({
      type: 'result',
      title: '주간 동기화 회의',
      // Decided in the dialog, not guessed from the title.
      suggestedPath: 'meetings/2026-09-20-weekly.md',
      unknownTerms: ['큐엠디'],
      speakerMap: { 이상욱: '이상욱' },
      warnings: [{ code: 'low_fidelity', detail: { score: 0.71 } }],
      assets: [],
    });
    expect(typeof result.draftId).toBe('string');
    expect(res.headers['Content-Type']).toBe('application/x-ndjson; charset=utf-8');

    // The draft is a plain import draft — that is what lets the meeting path
    // reuse POST /import/commit unchanged.
    const draft = getDraftStore().get(String(result.draftId), MANAGER);
    expect(draft?.document.source.kind).toBe('meeting');
    getDraftStore().delete(String(result.draftId), MANAGER);
  });

  it('hands the conversion the transcript and the meeting it was parked with', async () => {
    const res = makeRes();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: await uploadId() } }), res);

    expect(mockConvert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'T1',
        userId: 'U-manager',
        meta: expect.objectContaining({ title: '주간 동기화 회의', format: 'notes' }),
        transcript: expect.objectContaining({ kind: 'transcript-text' }),
        glossary: [],
        aliasGroups: [],
      }),
    );

    getDraftStore().delete(String((res.body as { draftId: string }).draftId), MANAGER);
  });

  it('answers plain JSON when the client did not ask for a stream', async () => {
    const res = makeRes();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: await uploadId() } }), res);

    expect(res.written).toHaveLength(0);
    expect(res.body).toMatchObject({ title: '주간 동기화 회의' });
    getDraftStore().delete(String((res.body as { draftId: string }).draftId), MANAGER);
  });

  it('spends the upload: a second convert with the same id is gone', async () => {
    const id = await uploadId();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: id } }), makeRes());

    const again = makeRes();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: id } }), again);

    expect(again.statusCode).toBe(410);
    expect((again.body as { error: string }).error).toBe('import_draft_expired');
  });

  it("answers an unknown, expired or somebody else's id the same way", async () => {
    const res = makeRes();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: 'never-existed' } }), res);
    expect(res.statusCode).toBe(410);

    const id = await uploadId();
    session = { workspaceId: 'T1', userId: 'U-someone-else' };
    const stolen = makeRes();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: id } }), stolen);
    expect(stolen.statusCode).toBe(410);

    session = MANAGER;
    getMeetingUploadStore().delete(id, MANAGER);
  });

  it("reports a refusal from the pipeline as the manager's to act on", async () => {
    const { ImportRefusal } = jest.requireActual('services/import/types');
    mockConvert.mockRejectedValue(new ImportRefusal(422, 'import_llm_unavailable'));

    const res = makeRes();
    await route('post', convertRoute)(makeReq({ params: { workspaceId: 'T1', uploadId: await uploadId() } }), res);

    expect(res.statusCode).toBe(422);
    expect((res.body as { error: string }).error).toBe('import_llm_unavailable');
  });

  it('ends a stream with an error line, since the status is long gone', async () => {
    mockConvert.mockImplementation(async (params) => {
      params.onProgress?.({ step: 'converting', label: 'Cleaning the transcript' });
      throw new Error('the model went away');
    });

    const res = makeRes();
    await route('post', convertRoute)(
      makeReq({ headers: NDJSON, params: { workspaceId: 'T1', uploadId: await uploadId() } }),
      res,
    );

    const last = res.lines().pop();
    expect(last).toMatchObject({ type: 'error', error: 'import_conversion_failed', status: 500 });
  });
});
