// The document-update review, its modals and its commit results after the
// catalog migration. Four things are worth testing here and nothing else is.
//
// 1. English did not move a byte. The suggestion card and the two modals are
//    compared against fixtures captured by running the pre-migration source, so
//    a rewritten sentence fails rather than quietly shipping.
// 2. Korean fits Slack's chrome — a modal whose title is over 24 characters is
//    rejected outright, and a translation is routinely 1.5x its English.
// 3. Nothing a handler routes on moved: action_ids, block_ids, callback_ids and
//    button values must be identical in every locale.
// 4. The two sentences that used to be assembled with `+=` still produce the
//    exact pre-migration English in *each* combination of links, which is the
//    part a "one key with slots" rewrite is most likely to get wrong.

const getSessionData = jest.fn();
const storeSessionData = jest.fn();
const getStoredDocumentUpdates = jest.fn();
const applyDocumentUpdatesToGithub = jest.fn();
const getWorkspaceConfig = jest.fn();
const getWritableFilesOrFetch = jest.fn();
const updateMarkdownFile = jest.fn();
const addNewSection = jest.fn();
const getMarkdownFile = jest.fn();

/** The workspace's language, and any per-user overrides, for one test. */
let workspaceLocale: 'en' | 'ko' = 'en';

jest.mock('services/common', () => ({
  SessionType: {
    DOCUMENT_UPDATE: 'document_update',
    NEW_SECTION: 'new_section',
    CREATE_FILE_MODAL: 'create_file_modal',
  },
  getSessionData: (...args: unknown[]) => getSessionData(...args),
  storeSessionData: (...args: unknown[]) => storeSessionData(...args),
  // Pinned so a button's value is a fixture rather than a clock reading.
  generateSessionId: (prefix: string) => `${prefix}_FIXED`,
}));

jest.mock('services/common/interaction-tracker', () => ({
  logButtonClick: jest.fn(async () => undefined),
  logModalSubmit: jest.fn(),
}));

jest.mock('services/document', () => ({
  getStoredDocumentUpdates: (...args: unknown[]) => getStoredDocumentUpdates(...args),
}));

jest.mock('services/document/section-utils', () => ({
  formatSectionPathWithLinks: jest.fn(() => 'Setup'),
}));

jest.mock('services/document/markdown', () => ({
  treeToMarkdown: jest.fn(() => '# updated'),
}));

jest.mock('services/document/document-update-service', () => ({
  DocumentUpdateService: {
    getInstance: () => ({
      stageMarkdownUpdate: jest.fn(async () => undefined),
      markGithubSyncSuccess: jest.fn(async () => undefined),
    }),
  },
}));

jest.mock('services/file-registry/main-service', () => ({
  VectorStoreService: {
    getInstance: () => ({
      addNewSection: (...args: unknown[]) => addNewSection(...args),
      getMarkdownFile: (...args: unknown[]) => getMarkdownFile(...args),
      ensureLoaded: async () => true,
    }),
  },
}));

jest.mock('services/github', () => ({
  GithubService: {
    getInstance: () => ({
      getDefaultBranch: jest.fn(async () => 'main'),
      updateMarkdownFile: (...args: unknown[]) => updateMarkdownFile(...args),
    }),
  },
  applyDocumentUpdatesToGithub: (...args: unknown[]) => applyDocumentUpdatesToGithub(...args),
}));

jest.mock('services/slack', () => ({
  getWorkspaceId: jest.fn(async () => 'T1'),
  getUserName: jest.fn(async () => 'Dana'),
  parseGithubUrl: jest.fn(() => ({ owner: 'o', repo: 'r' })),
}));

jest.mock('services/slack/message-text-utils', () => ({
  createDocumentUpdateText: jest.fn(() => '<<TEXT>>'),
}));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({
    getWorkspaceConfig: (...args: unknown[]) => getWorkspaceConfig(...args),
    getWritableFilesOrFetch: (...args: unknown[]) => getWritableFilesOrFetch(...args),
  })),
}));

// Only the timestamp is pinned; the rest of the block_id is the real format.
jest.mock('types/message-types', () => {
  const actual = jest.requireActual('../src/types/message-types');
  return { ...actual, createCHOIRBlockId: (type: string) => `choir_${type}_TS` };
});

// The resolvers are stubbed so a locale is a fixture rather than a database
// read; `createT` itself is the real one, because the rendered strings are the
// point of these tests.
jest.mock('services/i18n', () => {
  const { createT, isSupportedLocale } = jest.requireActual('../src/i18n');
  return {
    tForRequest: (context: any) => createT(isSupportedLocale(context?.locale) ? context.locale : 'en'),
    tForWorkspace: () => Promise.resolve(createT(workspaceLocale)),
    tForUser: () => Promise.resolve(createT(workspaceLocale)),
  };
});

import { createNewSectionAction } from '../listeners/features/document-update/actions/create-new-section';
import { showCreateFileModalCallback } from '../listeners/features/document-update/actions/show-create-file-modal';
import { applySelectedToGithubAction } from '../listeners/features/document-update/apply-document/apply-selected-to-github-action';
import { handleNewSectionModalSubmission } from '../listeners/features/document-update/apply-document/new-section-modal-submission';
import { buildSuggestionBlocks } from '../listeners/features/document-update/suggestions/blocks/suggestion-blocks';
import { SLACK_LIMITS, createT } from '../src/i18n';

const GITHUB_URL = 'https://github.com/o/r/blob/main/docs/guide.md';
const EDIT_URL = 'https://github.com/o/r/edit/main/docs/guide.md';
// The card builds its "edit in GitHub" link from the bare file name, not the path.
const FILE_EDIT_URL = 'https://github.com/o/r/edit/main/guide.md';
const COMMIT_URL = 'https://github.com/o/r/commit/abc123';
const NOW = 1_700_000_000_000;

const PROCESSED_DOC = {
  fileName: 'guide.md',
  githubUrl: GITHUB_URL,
  headingPath: ['Setup'],
  sectionName: 'Setup',
  hasChanges: true,
  nodeId: 'n1',
  suggestionType: 'UPDATE',
  nodeContent: 'old',
  updatedNodeContent: 'new',
  oldContent: 'old',
  newContent: 'new',
  diffBlock: { type: 'rich_text', elements: [] },
  updateAnchor: { startLine: 10, endLine: 14 },
  newSectionSuggestion: { sectionTitle: 'S', sectionContent: 'C', recommendedFile: 'guide.md', reasoning: 'R' },
} as any;

function renderCard(locale: 'en' | 'ko') {
  return buildSuggestionBlocks({
    processedDoc: PROCESSED_DOC,
    currentIndex: 0,
    sessionId: 'S1',
    knowledgeContent: 'K',
    knowledgeSourceChannelId: 'C1',
    knowledgeSourceThreadTs: '111.1',
    userId: 'U1',
    isFirstSuggestion: true,
    suggestionNumber: 1,
    client: {},
    t: createT(locale),
  });
}

/** Every mrkdwn/plain_text string in a block tree, in render order. */
function textsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  if ((record.type === 'mrkdwn' || record.type === 'plain_text') && typeof record.text === 'string') {
    return [record.text];
  }
  return Object.values(record).flatMap(textsOf);
}

/** Everything a handler routes on, which no translation may touch. */
function identifiersOf(node: unknown): string {
  return JSON.stringify(node, (key, value) =>
    ['text', 'placeholder', 'label', 'title', 'submit', 'close', 'initial_value'].includes(key) ? undefined : value,
  );
}

/**
 * The suggestion card exactly as it read before the migration, captured by
 * running the pre-migration builder against the fixture above.
 */
const PRE_MIGRATION_CARD_TEXTS = [
  '📝 *Update Suggestion 1*',
  "📝 I found content that could be *updated* based on your knowledge. I'm showing you the specific changes I'd recommend - you can see exactly what would be modified or added.",
  `File: <${GITHUB_URL}|guide.md>\nSection: Setup\nAnchor: lines 10-14`,
  'Edit This',
  '✅ Apply Changes',
  '⏭️ Skip This',
  'Stop Review',
  '📁 *Updating this file* — pick another to switch:',
  'Choose a file...',
  'guide.md',
  'guide.md',
  `💡 *Other options:* You can create a new section instead of updating this one, or edit guide.md directly in GitHub <${FILE_EDIT_URL}|here>.`,
  '💡 Create New Section',
  '📄 Create New File',
  '🔄 Start Over',
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  workspaceLocale = 'en';
  getSessionData.mockReturnValue(undefined);
  getWorkspaceConfig.mockResolvedValue({ githubRepo: { owner: 'o', repo: 'r', branch: 'main' } });
  getWritableFilesOrFetch.mockResolvedValue([{ name: 'guide.md', path: 'docs/guide.md' }]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the suggestion card', () => {
  it('renders every English string exactly as it did before the migration', async () => {
    expect(textsOf(await renderCard('en'))).toEqual(PRE_MIGRATION_CARD_TEXTS);
  });

  it('keeps every action_id, block_id and button value when the locale changes', async () => {
    expect(identifiersOf(await renderCard('ko'))).toEqual(identifiersOf(await renderCard('en')));
  });

  it('speaks Korean to a Korean reviewer', async () => {
    const texts = textsOf(await renderCard('ko'));

    expect(texts[0]).toBe('📝 *업데이트 제안 1*');
    expect(texts[2]).toBe(`파일: <${GITHUB_URL}|guide.md>\n섹션: Setup\n기준 위치: 10-14번째 줄`);
    expect(texts[3]).toBe('이 내용 편집');
    expect(texts[4]).toBe('✅ 변경 사항 적용');
    expect(texts.at(-1)).toBe('🔄 처음부터 다시');
  });

  it('keeps the 💡 prefix message-cleanup strips stale hints by', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const hint = textsOf(await renderCard(locale)).find((text) => text.includes('*'));
      expect(hint).toBeDefined();
    }
    const koreanHint = textsOf(await renderCard('ko')).find((text) => text.includes('새 섹션을 만들 수도'));
    expect(koreanHint?.startsWith('💡')).toBe(true);
  });

  it('keeps every Korean button inside Slack’s limit', async () => {
    const blocks = (await renderCard('ko')) as any[];
    const labels = blocks
      .filter((block) => block.type === 'actions')
      .flatMap((block) => block.elements.map((element: any) => element.text.text));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // Compared as an object so a failure names the label that overflowed.
      expect({ label, ok: label.length <= SLACK_LIMITS.button }).toEqual({ label, ok: true });
    }
  });
});

/** Runs a modal-opening handler and returns the view it opened. */
async function openModal(callback: (args: any) => Promise<void>, locale: 'en' | 'ko', actionValue: string) {
  const open = jest.fn(async () => ({ ok: true }));
  await callback({
    ack: async () => {},
    body: {
      actions: [{ value: actionValue }],
      user: { id: 'U1' },
      channel: { id: 'D1' },
      container: { message_ts: '111.0' },
      trigger_id: 'TRIG',
    },
    client: { views: { open }, chat: { postMessage: jest.fn(async () => ({})) } },
    context: { locale },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  expect(open).toHaveBeenCalledTimes(1);
  return (open.mock.calls[0] as any[])[0].view;
}

const PRE_MIGRATION_CREATE_FILE_VIEW = {
  type: 'modal',
  callback_id: 'create_file_modal',
  notify_on_close: true,
  title: { type: 'plain_text', text: 'Create New File' },
  submit: { type: 'plain_text', text: 'Create File' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📄 *Create a new markdown file in your repository*\n\nThis will create a new .md file in your GitHub repository and make it available for documentation updates.',
      },
    },
    { type: 'divider' },
    {
      type: 'input',
      block_id: 'file_name_input',
      element: {
        type: 'plain_text_input',
        action_id: 'file_name',
        placeholder: { type: 'plain_text', text: 'e.g., new-documentation.md' },
        initial_value: 'notes.md',
      },
      label: { type: 'plain_text', text: 'File Name (must end with .md)' },
    },
    {
      type: 'input',
      block_id: 'file_content_input',
      element: {
        type: 'plain_text_input',
        action_id: 'file_content',
        multiline: true,
        placeholder: { type: 'plain_text', text: '# New Documentation\n\nAdd your initial content here...' },
        initial_value: '# Notes',
      },
      label: { type: 'plain_text', text: 'Initial Content (Markdown)' },
    },
  ],
  private_metadata: JSON.stringify({ createFileSessionId: 'CF1', userId: 'U1', channelId: 'D1' }),
};

describe('the create-file modal', () => {
  beforeEach(() => {
    getSessionData.mockReturnValue({ sessionId: 'S1', defaultFileName: 'notes.md', defaultInitialContent: '# Notes' });
  });

  it('renders byte-for-byte as it did before the migration', async () => {
    expect(await openModal(showCreateFileModalCallback, 'en', 'CF1')).toEqual(PRE_MIGRATION_CREATE_FILE_VIEW);
  });

  it('speaks Korean, inside Slack’s chrome limits, without moving an identifier', async () => {
    const korean = await openModal(showCreateFileModalCallback, 'ko', 'CF1');
    const english = await openModal(showCreateFileModalCallback, 'en', 'CF1');

    expect(korean.title.text).toBe('새 파일 만들기');
    expect(korean.submit.text).toBe('파일 만들기');
    expect(korean.close.text).toBe('취소');
    expect(korean.blocks[2].label.text).toBe('파일 이름 (.md로 끝나야 해요)');
    expect(korean.blocks[3].element.placeholder.text).toBe('# 새 문서\n\n여기에 초기 내용을 적어 주세요...');

    expect(identifiersOf(korean)).toEqual(identifiersOf(english));
    expect({ text: korean.title.text, ok: korean.title.text.length <= SLACK_LIMITS.title }).toEqual({
      text: korean.title.text,
      ok: true,
    });
    for (const footer of [korean.submit, korean.close]) {
      expect({ text: footer.text, ok: footer.text.length <= SLACK_LIMITS.button }).toEqual({
        text: footer.text,
        ok: true,
      });
    }
  });
});

const PRE_MIGRATION_NEW_SECTION_VIEW = {
  type: 'modal',
  callback_id: 'new_section_modal',
  notify_on_close: true,
  title: { type: 'plain_text', text: 'Create a New Section' },
  close: { type: 'plain_text', text: 'Cancel' },
  submit: { type: 'plain_text', text: 'Submit', emoji: true },
  private_metadata: 'new_section_modal_FIXED',
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "👋 I've prepared a new section for your documentation. Review and edit the content below, then click *Submit* to automatically add it to your selected file.\n\n",
      },
    },
    { type: 'divider' },
    {
      type: 'input',
      block_id: 'file_selection_input',
      label: { type: 'plain_text', text: 'Select Target File', emoji: true },
      element: {
        type: 'static_select',
        action_id: 'file_selection',
        placeholder: { type: 'plain_text', text: 'Choose a file...' },
        initial_option: { text: { type: 'plain_text', text: 'guide.md' }, value: 'docs/guide.md' },
        options: [{ text: { type: 'plain_text', text: 'guide.md' }, value: 'docs/guide.md' }],
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: "*🎯 Here's the section I've prepared for you:*" } },
    {
      type: 'input',
      block_id: 'section_title_input',
      label: { type: 'plain_text', text: 'Section Title', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: 'section_title',
        initial_value: 'S',
        placeholder: { type: 'plain_text', text: 'Enter section title...' },
      },
    },
    {
      type: 'input',
      block_id: 'section_body_input',
      label: { type: 'plain_text', text: 'Section Content', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: 'section_body',
        initial_value: '- line one\n- line two',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Enter section content...' },
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '📝 *Alternatively, you can edit the selected file manually in GitHub:*' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '🔗 Get Edit Link', emoji: true },
        action_id: 'get_edit_link_for_selected_file',
        value: 'new_section_modal_FIXED',
      },
    },
  ],
};

describe('the new-section modal', () => {
  beforeEach(() => {
    getSessionData.mockReturnValue({
      sectionTitle: 'S',
      sectionContent: 'line one\nline two',
      recommendedFile: 'docs/guide.md',
      reasoning: 'R',
      githubUrl: GITHUB_URL,
      originalChannelId: 'C1',
      originalThreadTs: '111.1',
      sessionId: 'S1',
    });
  });

  it('renders byte-for-byte as it did before the migration', async () => {
    const value = JSON.stringify({ newSectionSessionId: 'NS1', userId: 'U1' });
    expect(await openModal(createNewSectionAction, 'en', value)).toEqual(PRE_MIGRATION_NEW_SECTION_VIEW);
  });

  it('speaks Korean, inside Slack’s chrome limits, without moving an identifier', async () => {
    const value = JSON.stringify({ newSectionSessionId: 'NS1', userId: 'U1' });
    const korean = await openModal(createNewSectionAction, 'ko', value);
    const english = await openModal(createNewSectionAction, 'en', value);

    expect(korean.title.text).toBe('새 섹션 만들기');
    expect(korean.submit.text).toBe('제출');
    expect(korean.blocks[2].label.text).toBe('추가할 파일 선택');
    expect(korean.blocks[4].label.text).toBe('섹션 제목');
    expect(korean.blocks[6].accessory.text.text).toBe('🔗 편집 링크 받기');

    expect(identifiersOf(korean)).toEqual(identifiersOf(english));
    expect({ text: korean.title.text, ok: korean.title.text.length <= SLACK_LIMITS.title }).toEqual({
      text: korean.title.text,
      ok: true,
    });
    for (const footer of [korean.submit, korean.close]) {
      expect({ text: footer.text, ok: footer.text.length <= SLACK_LIMITS.button }).toEqual({
        text: footer.text,
        ok: true,
      });
    }
  });
});

/** Applies one update and returns the text the result DM was rewritten to. */
async function applyAndReadResult(commitSha?: string): Promise<string> {
  getStoredDocumentUpdates.mockReturnValue([
    { nodeId: 'n1', fileName: 'guide.md', githubUrl: GITHUB_URL, oldContent: 'old', newContent: 'new' },
  ]);
  applyDocumentUpdatesToGithub.mockResolvedValue([{ success: true, fileName: 'guide.md', commitSha }]);

  const update = jest.fn(async () => ({ ok: true }));
  await applySelectedToGithubAction({
    ack: async () => {},
    body: {
      actions: [{ value: JSON.stringify({ userId: 'U1', nodeId: 'n1' }) }],
      user: { id: 'U1' },
      channel: { id: 'D1' },
    },
    client: {
      conversations: { open: jest.fn(async () => ({ ok: true, channel: { id: 'D1' } })) },
      chat: { postMessage: jest.fn(async () => ({ ok: true, ts: '1.0' })), update },
    },
    context: { locale: 'en' },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as any);

  return (update.mock.calls[0] as any[])[0].text;
}

/** Submits the new-section modal and returns the text the card was rewritten to. */
async function submitNewSectionAndReadResult(commitSha?: string): Promise<string> {
  getSessionData.mockImplementation((_id: string, type: string) =>
    type === 'new_section'
      ? {
          recommendedFile: 'guide.md',
          userId: 'U1',
          recommendedFileEditUrl: EDIT_URL,
          buttonMessageTs: '111.0',
          buttonChannelId: 'D1',
          branch: 'main',
        }
      : undefined,
  );
  addNewSection.mockResolvedValue(true);
  getMarkdownFile.mockReturnValue({ tree: {}, githubUrl: GITHUB_URL, path: 'docs/guide.md' });
  updateMarkdownFile.mockResolvedValue({ commitSha });

  const update = jest.fn(async () => ({ ok: true }));
  await handleNewSectionModalSubmission({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      view: {
        private_metadata: 'NSM1',
        state: {
          values: {
            section_title_input: { section_title: { value: 'T' } },
            section_body_input: { section_body: { value: 'B' } },
            file_selection_input: { file_selection: {} },
          },
        },
      },
    },
    client: { chat: { postMessage: jest.fn(async () => ({})), update } },
    context: { locale: 'en' },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as any);

  return (update.mock.calls[0] as any[])[0].text;
}

describe('the sentences that used to be built with +=', () => {
  const BOTH_LINKS = `\n\n📝 You can <${COMMIT_URL}|view the changes> or <${EDIT_URL}|edit the file> directly on GitHub.`;
  const EDIT_ONLY = `\n\n📝 You can <${EDIT_URL}|edit the file> directly on GitHub.`;

  it('offers both links after a commit, exactly as before', async () => {
    expect(await applyAndReadResult('abc123')).toBe(
      `✅ Great news! I've successfully updated the document: <${GITHUB_URL}|*guide.md*>${BOTH_LINKS}`,
    );
  });

  it('offers only the edit link when there is no commit sha, exactly as before', async () => {
    expect(await applyAndReadResult(undefined)).toBe(
      `✅ Great news! I've successfully updated the document: <${GITHUB_URL}|*guide.md*>${EDIT_ONLY}`,
    );
  });

  it('builds the new-section receipt with both links, exactly as before', async () => {
    expect(await submitNewSectionAndReadResult('abc123')).toBe(
      `✅ New section "T" added successfully to GitHub!\n\n📁 *File:* <${GITHUB_URL}|guide.md>\n📝 *Added by:* Dana${BOTH_LINKS}\n\n🔍 *Preview:*\n\`\`\`# T\nB\`\`\``,
    );
  });

  it('builds the new-section receipt with only the edit link, exactly as before', async () => {
    expect(await submitNewSectionAndReadResult(undefined)).toBe(
      `✅ New section "T" added successfully to GitHub!\n\n📁 *File:* <${GITHUB_URL}|guide.md>\n📝 *Added by:* Dana${EDIT_ONLY}\n\n🔍 *Preview:*\n\`\`\`# T\nB\`\`\``,
    );
  });
});
