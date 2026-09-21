// The first half of a document-update review, seen through a project channel.
//
// Three behaviours meet here and they are easiest to pin together, because they
// share one search: the candidate search is confined to the project folder, a
// folder that turns up nothing widens the search *and* says so in the manager's
// DM, and the "Create New File" default lands inside the folder rather than at
// the repository root.

const qmdSearch = jest.fn();
const runFileBasedSearch = jest.fn(async () => ({ shouldReturn: false, searchResults: [], isFirstSuggestion: true }));
const generateNewFileDefaults = jest.fn(async () => ({
  fileName: 'retention-policy.md',
  initialContent: '# Retention policy',
}));
const storeSessionData = jest.fn();
const getReadOnlyFiles = jest.fn(async () => [] as string[]);

jest.mock('services/document/qmd-update-anchor-service', () => ({
  QmdUpdateAnchorService: { getInstance: () => ({ search: (...args: unknown[]) => qmdSearch(...(args as [])) }) },
}));

jest.mock('../listeners/features/document-update/suggestions/flows/file-based-search-flow', () => ({
  runFileBasedSearch: (...args: unknown[]) => runFileBasedSearch(...(args as [])),
}));

jest.mock('services/llm/content-generator', () => ({
  generateNewFileDefaults: (...args: unknown[]) => generateNewFileDefaults(...(args as [])),
  createNewSectionFromKnowledge: jest.fn(async () => null),
}));

jest.mock('services/common', () => ({
  SessionType: { DOCUMENT_UPDATE: 'document_update' },
  getSessionData: jest.fn(() => ({})),
  storeSessionData: (...args: unknown[]) => storeSessionData(...(args as [])),
}));

jest.mock('services/document/document-store', () => ({
  storeSearchResults: jest.fn(),
  initializeFileSelectionState: jest.fn(),
}));

jest.mock('services/slack', () => ({ getWorkspaceId: jest.fn(async () => 'T1') }));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({
    getWritableFilesOrFetch: jest.fn(async () => [{ name: 'a.md', path: 'projects/alpha/a.md' }]),
    getReadOnlyFiles: (...args: unknown[]) => getReadOnlyFiles(...(args as [])),
  })),
}));

// Real scope helper, stubbed index: the folder prefix arrives as a parameter
// here, so nothing has to walk a mirror.
jest.mock('services/projects/project-index', () => ({
  resolveProjectForChannel: jest.fn(async () => null),
}));

jest.mock('services/common/logger', () => ({
  Logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { runInitialSearch } from '../listeners/features/document-update/suggestions/flows/initial-search-flow';
import { createT } from '../src/i18n';

const t = createT('en');
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const anchor = (fileName: string) => ({
  pageContent: `section of ${fileName}`,
  metadata: { fileName, nodeId: `qmd:${fileName}:1:1` },
});

const postMessage = jest.fn(async () => ({ ts: '1.1', channel: 'D1' }));
const client = { chat: { postMessage } };

const run = (folderPrefix: string | null) =>
  runInitialSearch({
    userId: 'U1',
    currentWorkspaceId: 'T1',
    currentDmChannelId: 'D1',
    knowledgeContent: 'Retention is 90 days.',
    sessionId: 'S1',
    knowledgeSourceChannelId: 'C1',
    knowledgeSourceThreadTs: undefined,
    vectorStore: { getAllMarkdownFiles: () => [] },
    client,
    logger,
    folderPrefix,
    t,
  });

beforeEach(() => {
  jest.clearAllMocks();
  getReadOnlyFiles.mockResolvedValue([]);
  generateNewFileDefaults.mockResolvedValue({
    fileName: 'retention-policy.md',
    initialContent: '# Retention policy',
  });
  runFileBasedSearch.mockResolvedValue({ shouldReturn: false, searchResults: [], isFirstSuggestion: true });
});

describe('runInitialSearch inside a project folder', () => {
  it('confines the candidate search to the folder', async () => {
    qmdSearch.mockResolvedValue([anchor('projects/alpha/design.md')]);

    await run('projects/alpha');

    expect(qmdSearch).toHaveBeenCalledTimes(1);
    expect(qmdSearch).toHaveBeenCalledWith(expect.objectContaining({ folderPrefix: 'projects/alpha' }));
    // Nothing was widened, so the manager gets no notice.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('searches the whole repository when the folder has nothing, and says so once', async () => {
    qmdSearch.mockImplementation(async (params: { folderPrefix?: string }) =>
      params.folderPrefix ? [] : [anchor('handbook/policies.md')],
    );

    await run('projects/alpha');

    expect(qmdSearch.mock.calls.map((call) => call[0].folderPrefix)).toEqual(['projects/alpha', undefined]);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const posted = postMessage.mock.calls[0][0] as unknown as { text: string };
    expect(posted.text).toBe('_Nothing in `projects/alpha` matched, so I searched the whole repository._');
  });

  it('does not re-apply the folder to the file the widened search recommended', async () => {
    qmdSearch.mockImplementation(async (params: { folderPrefix?: string }) =>
      params.folderPrefix ? [] : [anchor('handbook/policies.md')],
    );

    await run('projects/alpha');

    expect(runFileBasedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        folderPrefix: null,
        parsedValue: expect.objectContaining({ selectedFile: 'handbook/policies.md' }),
      }),
    );
  });

  it('hands the folder on to the file-scoped search when the folder did match', async () => {
    qmdSearch.mockResolvedValue([anchor('projects/alpha/design.md')]);

    await run('projects/alpha');

    expect(runFileBasedSearch).toHaveBeenCalledWith(expect.objectContaining({ folderPrefix: 'projects/alpha' }));
  });

  it('defaults a new document into the project folder', async () => {
    qmdSearch.mockResolvedValue([anchor('projects/alpha/design.md')]);

    await run('projects/alpha');

    const stored = storeSessionData.mock.calls[0][1] as { newFileDefaults: { fileName: string } };
    expect(stored.newFileDefaults.fileName).toBe('projects/alpha/retention-policy.md');
  });
});

describe('runInitialSearch without a project', () => {
  it('searches the whole repository and leaves the new-file default at the root', async () => {
    qmdSearch.mockResolvedValue([anchor('handbook/policies.md')]);

    await run(null);

    expect(qmdSearch).toHaveBeenCalledTimes(1);
    expect(qmdSearch.mock.calls[0][0].folderPrefix).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();

    const stored = storeSessionData.mock.calls[0][1] as { newFileDefaults: { fileName: string } };
    expect(stored.newFileDefaults.fileName).toBe('retention-policy.md');
  });
});
