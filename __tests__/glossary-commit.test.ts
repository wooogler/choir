import { createDocument } from '../services/docs-editor/create-document';
import { saveEditedDocument } from '../services/docs-editor/save-document';
import { GlossaryRefusal, commitGlossaryRows } from '../services/glossary/commit';
import { glossaryFileFor } from '../services/glossary/load';
import { WorkspaceMirrorService } from '../services/workspace/mirror-service';

/**
 * Where the rows land and what the commit says.
 *
 * The rule under test is the one the loader reads by — nearest glossary wins,
 * and a folder that has none gets one — plus the escape hatch a team needs when
 * the organization's root glossary got there first. The commit itself is
 * mocked: `createDocument` and `saveEditedDocument` have their own suites and
 * between them they pull GitHub, the vector store and the mirror into a process
 * jest would rather not load.
 */

jest.mock('../services/docs-editor/create-document', () => {
  class CreateDocumentRefusal extends Error {
    readonly status: number;
    readonly apiCode: string;
    constructor(status: number, apiCode: string) {
      super(apiCode);
      this.status = status;
      this.apiCode = apiCode;
    }
  }
  return { createDocument: jest.fn(), CreateDocumentRefusal };
});
jest.mock('../services/docs-editor/save-document', () => ({ saveEditedDocument: jest.fn() }));
jest.mock('../services/glossary/load', () => ({
  ...jest.requireActual('../services/glossary/load'),
  glossaryFileFor: jest.fn(),
}));

const mockCreate = createDocument as jest.MockedFunction<typeof createDocument>;
const mockSave = saveEditedDocument as jest.MockedFunction<typeof saveEditedDocument>;
const mockNearest = glossaryFileFor as jest.MockedFunction<typeof glossaryFileFor>;

const WS = 'T1';
const USER = 'U-manager';

/** What the mirror holds, keyed by repository path. */
let mirror: Record<string, string> = {};

const EXISTING_GLOSSARY = [
  '# 용어집',
  '',
  '| 용어 | 다른 표기 | 설명 |',
  '| --- | --- | --- |',
  '| CHOIR | 코이어 | Slack 지식 봇 |',
  '',
].join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  mirror = {};
  mockNearest.mockResolvedValue(null);
  mockCreate.mockResolvedValue({ commitSha: 'sha-created', filePath: 'ignored.md' });
  mockSave.mockResolvedValue({ commitSha: 'sha-saved' });
  jest
    .spyOn(WorkspaceMirrorService, 'getInstance')
    .mockReturnValue({ readMirrorFile: async (_ws: string, file: string) => mirror[file] ?? null } as never);
});

afterAll(() => {
  jest.restoreAllMocks();
});

const rows = (...list: Array<[string, string[], string]>) =>
  list.map(([term, aliases, description]) => ({ term, aliases, description }));

describe('commitGlossaryRows: where the rows land', () => {
  it('appends to the nearest existing glossary, wherever in the chain it is', async () => {
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    const result = await commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: 'projects/alpha',
      rows: rows(['QMD', ['큐엠디'], '로컬 검색 인덱스']),
    });

    expect(result).toEqual({ path: 'GLOSSARY.md', commitSha: 'sha-saved', added: 1, skipped: [], created: false });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        userId: USER,
        filePath: 'GLOSSARY.md',
        commitMessage: 'Add 1 glossary term',
      }),
    );
    // The row joined the table that was already there; nothing else moved.
    const content = mockSave.mock.calls[0][0].content;
    expect(content).toContain('| CHOIR | 코이어 | Slack 지식 봇 |\n| QMD | 큐엠디 | 로컬 검색 인덱스 |');
  });

  it('creates the folder’s glossary from the template when the chain has none', async () => {
    const result = await commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: 'meetings',
      rows: rows(['RAG', ['래그'], '검색 결과를 붙여 답을 생성하는 방식'], ['QMD', [], '로컬 검색 인덱스']),
    });

    expect(result).toMatchObject({ path: 'meetings/GLOSSARY.md', commitSha: 'sha-created', added: 2, created: true });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'meetings/GLOSSARY.md', commitMessage: 'Create glossary for meetings' }),
    );
    // The template's own title and headers, in the language of the rows.
    expect(mockCreate.mock.calls[0][0].content).toBe(
      [
        '# 용어집',
        '',
        '| 용어 | 다른 표기 | 설명 |',
        '| --- | --- | --- |',
        '| RAG | 래그 | 검색 결과를 붙여 답을 생성하는 방식 |',
        '| QMD |  | 로컬 검색 인덱스 |',
        '',
      ].join('\n'),
    );
  });

  it('names the repository root in the message when the glossary is created there', async () => {
    await commitGlossaryRows({ workspaceId: WS, userId: USER, folder: '', rows: rows(['CHOIR', [], 'The bot']) });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'GLOSSARY.md', commitMessage: 'Create glossary for the repository root' }),
    );
    // English rows, English template.
    expect(mockCreate.mock.calls[0][0].content).toContain('| Term | Also known as | Description |');
  });

  it('honours createAt: folder so a team can have its own glossary under the root one', async () => {
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    const result = await commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: 'projects/alpha',
      rows: rows(['QMD', [], 'The index']),
      createAt: 'folder',
    });

    expect(result).toMatchObject({ path: 'projects/alpha/GLOSSARY.md', created: true });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('still appends when createAt: folder names a folder that already has one', async () => {
    mockNearest.mockResolvedValue('projects/alpha/Glossary.md');
    mirror['projects/alpha/Glossary.md'] = EXISTING_GLOSSARY;

    const result = await commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: 'projects/alpha',
      rows: rows(['QMD', [], 'The index']),
      createAt: 'folder',
    });

    // The differently-cased file is the same file; creating a second one beside
    // it would split the folder's terms across two documents.
    expect(result).toMatchObject({ path: 'projects/alpha/Glossary.md', created: false });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('respects a workspace that calls its glossary something else', async () => {
    await commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: 'meetings',
      rows: rows(['QMD', [], 'The index']),
      fileName: 'TERMS.md',
    });

    expect(mockNearest).toHaveBeenCalledWith(WS, 'meetings', { fileName: 'TERMS.md' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'meetings/TERMS.md' }));
  });
});

describe('commitGlossaryRows: what it refuses', () => {
  it('refuses a path that could not be committed', async () => {
    const attempt = commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: '.choir/context',
      rows: rows(['QMD', [], 'The index']),
    });

    await expect(attempt).rejects.toMatchObject({ status: 400, apiCode: 'glossary_file_invalid' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a glossary filename that is not a markdown file', async () => {
    const attempt = commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: 'meetings',
      rows: rows(['QMD', [], 'The index']),
      fileName: 'terms.txt',
    });

    await expect(attempt).rejects.toBeInstanceOf(GlossaryRefusal);
    await expect(attempt).rejects.toMatchObject({ apiCode: 'glossary_file_invalid' });
  });

  it('refuses a folder that would climb out of the repository', async () => {
    const attempt = commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: '../secrets',
      rows: rows(['QMD', [], 'The index']),
    });

    await expect(attempt).rejects.toMatchObject({ apiCode: 'glossary_file_invalid' });
  });

  it('refuses a request with no usable rows', async () => {
    const attempt = commitGlossaryRows({ workspaceId: WS, userId: USER, folder: '', rows: [] });

    await expect(attempt).rejects.toMatchObject({ status: 400, apiCode: 'glossary_no_terms' });
  });

  it('commits nothing when every row is already in the file', async () => {
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    const attempt = commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: '',
      rows: rows(['choir', [], 'A second opinion']),
    });

    // An empty diff under a message that claims otherwise is worse than a refusal.
    await expect(attempt).rejects.toMatchObject({ status: 409, apiCode: 'glossary_no_terms' });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('reports the duplicates it skipped alongside the rows it added', async () => {
    mockNearest.mockResolvedValue('GLOSSARY.md');
    mirror['GLOSSARY.md'] = EXISTING_GLOSSARY;

    const result = await commitGlossaryRows({
      workspaceId: WS,
      userId: USER,
      folder: '',
      rows: rows(['CHOIR', [], 'again'], ['QMD', [], 'The index']),
    });

    expect(result).toMatchObject({ added: 1, skipped: ['CHOIR'], created: false });
    expect(mockSave.mock.calls[0][0].commitMessage).toBe('Add 1 glossary term');
  });
});
