// The App Home GitHub connection flow and the index-management buttons after
// the catalog migration.
//
// Three things are worth testing here. English must not have moved a byte: the
// repository picker is a modal a manager connects a production repository
// through, and the fixtures below were captured by running the builders on the
// pre-migration source. Korean must fit Slack's chrome — a modal title over 24
// characters is not a layout wobble, Slack rejects the view — and that includes
// the option label after a long repository name has been through the 75-char
// truncator. And the long-running index jobs must narrate themselves in the
// language of the person who clicked, from the progress line to the result.

const logAppHomeButtonClick = jest.fn(async () => undefined);
const refreshAppHomeSoon = jest.fn();
const getAllMarkdownFiles = jest.fn();
const initialize = jest.fn(async () => true);
const syncWorkspaceFromMarkdownFiles = jest.fn(async () => undefined);
const setMarkdownFilesCache = jest.fn(async () => undefined);

// `createT` itself is the real one — the rendered Korean is the point — while
// the resolver is a stub so a locale is a fixture rather than a database read.
jest.mock('services/i18n', () => {
  const { createT, isSupportedLocale } = jest.requireActual('../src/i18n');
  return {
    tForRequest: (context: any) => createT(isSupportedLocale(context?.locale) ? context.locale : 'en'),
  };
});

jest.mock('services/common/interaction-tracker', () => ({
  logAppHomeButtonClick: (...args: unknown[]) => logAppHomeButtonClick(...(args as [])),
}));

jest.mock('../listeners/features/app-home/refresh', () => ({
  refreshAppHomeSoon: (...args: unknown[]) => refreshAppHomeSoon(...args),
  refreshAppHome: jest.fn(async () => undefined),
}));

jest.mock('services/slack', () => ({
  getWorkspaceId: jest.fn(async () => 'T1'),
  isWorkspaceOwner: jest.fn(async () => true),
  isManager: jest.fn(async () => true),
  getGithubRepo: jest.fn(async () => ({ owner: 'acme', repo: 'handbook', path: 'docs', branch: 'main' })),
  storeGithubRepo: jest.fn(async () => undefined),
}));

jest.mock('services/github', () => ({
  GithubService: { getInstance: () => ({ getAllMarkdownFiles, getDefaultBranch: jest.fn(async () => 'main') }) },
}));

jest.mock('services/file-registry/main-service', () => ({
  VectorStoreService: { getInstance: () => ({ initialize, extractRepoInfoFromFiles: jest.fn(() => null) }) },
}));

jest.mock('services/sync/github-sync-service', () => ({
  GitHubSyncService: { getInstance: () => ({ syncWorkspaceFromMarkdownFiles }) },
}));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({ setMarkdownFilesCache })),
}));

import {
  buildRepositoryEmptyView,
  buildRepositoryLoadingView,
  buildRepositorySelectionView,
  formatRepositoryOptionText,
} from '../listeners/features/app-home/github/repository-selection-views';
import { reloadFromGithubAction } from '../listeners/features/index-management/actions/reload-from-github-action';
import { SLACK_LIMITS, type T, createT } from '../src/i18n';

const METADATA = { userId: 'U1', workspaceId: 'T1' };

/** The option list the browse handler feeds the selection view. */
function repoOptions(t: T) {
  return [
    {
      text: {
        type: 'plain_text' as const,
        text: formatRepositoryOptionText(t, { full_name: 'acme/handbook', markdownStats: { markdownFiles: 42 } }),
      },
      description: {
        type: 'plain_text' as const,
        text: t('appHome.github.repoPicker.option.description', { count: 42, percent: '63.6', total: 66 }),
      },
      value: JSON.stringify({ owner: 'acme', repo: 'handbook' }),
    },
  ];
}

// ---------------------------------------------------------------------------
// English, captured before the migration
// ---------------------------------------------------------------------------

const PRE_MIGRATION_LOADING_VIEW = {
  type: 'modal',
  callback_id: 'select_repository_loading_modal',
  notify_on_close: true,
  title: { type: 'plain_text', text: 'Select Repository' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⏳ *Loading repositories*\n\nChecking which repositories you can write to and which ones already contain `.md` files...',
      },
    },
  ],
  private_metadata: '{"userId":"U1","workspaceId":"T1"}',
};

const PRE_MIGRATION_SELECTION_VIEW = {
  type: 'modal',
  callback_id: 'select_repository_modal',
  notify_on_close: true,
  title: { type: 'plain_text', text: 'Select Repository' },
  submit: { type: 'plain_text', text: 'Connect Repository' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📂 *Select a GitHub repository to connect*\n\nChoose a public repository you can write to, or paste a public GitHub repository URL below. Private repositories are not supported.',
      },
    },
    {
      type: 'input',
      block_id: 'repository_select_block',
      element: {
        type: 'static_select',
        action_id: 'repository_select',
        placeholder: { type: 'plain_text', text: 'Choose a repository...' },
        options: [
          {
            text: { type: 'plain_text', text: 'acme/handbook (42 md)' },
            description: { type: 'plain_text', text: '42 markdown files · 63.6% of 66 files' },
            value: '{"owner":"acme","repo":"handbook"}',
          },
        ],
      },
      label: { type: 'plain_text', text: 'Repository' },
      optional: true,
    },
    {
      type: 'input',
      block_id: 'repository_url_block',
      element: {
        type: 'plain_text_input',
        action_id: 'repository_url',
        placeholder: { type: 'plain_text', text: 'https://github.com/owner/repo or /tree/branch/docs' },
      },
      label: { type: 'plain_text', text: 'Repository URL' },
      optional: true,
    },
    {
      type: 'input',
      block_id: 'path_input_block',
      element: {
        type: 'plain_text_input',
        action_id: 'path_input',
        placeholder: { type: 'plain_text', text: 'docs/ (optional - leave empty for root)' },
      },
      label: { type: 'plain_text', text: 'Path in Repository' },
      optional: true,
    },
  ],
  private_metadata: '{"userId":"U1","workspaceId":"T1"}',
};

const PRE_MIGRATION_EMPTY_VIEW = {
  type: 'modal',
  callback_id: 'select_repository_empty_modal',
  notify_on_close: true,
  title: { type: 'plain_text', text: 'Select Repository' },
  close: { type: 'plain_text', text: 'Close' },
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '❌ No public writable repositories with markdown files were found.' },
    },
  ],
  private_metadata: '{"userId":"U1","workspaceId":"T1"}',
};

describe('repository selection views in English', () => {
  const t = createT('en');

  it('renders the loading view exactly as it did before the migration', () => {
    expect(buildRepositoryLoadingView(t, METADATA)).toEqual(PRE_MIGRATION_LOADING_VIEW);
  });

  it('renders the selection view exactly as it did before the migration', () => {
    expect(buildRepositorySelectionView(t, METADATA, repoOptions(t))).toEqual(PRE_MIGRATION_SELECTION_VIEW);
  });

  it('renders the empty view exactly as it did before the migration', () => {
    expect(buildRepositoryEmptyView(t, METADATA)).toEqual(PRE_MIGRATION_EMPTY_VIEW);
  });

  it('formats option labels exactly as it did before the migration', () => {
    expect(formatRepositoryOptionText(t, { full_name: 'acme/handbook', markdownStats: { markdownFiles: 42 } })).toBe(
      'acme/handbook (42 md)',
    );
    expect(formatRepositoryOptionText(t, { full_name: 'acme/handbook' })).toBe('acme/handbook');
    expect(
      formatRepositoryOptionText(t, {
        full_name: 'an-extremely-long-github-organization-name/an-equally-long-repository-name-here',
        markdownStats: { markdownFiles: 128 },
      }),
    ).toBe('an-extremely-long-github-organization-name/an-equally-long-repository-na...');
  });
});

// ---------------------------------------------------------------------------
// Korean
// ---------------------------------------------------------------------------

const HANGUL = /[가-힣]/;

/** Every length-capped field in a modal view, paired with the cap it must obey. */
function cappedFields(view: any): Array<{ where: string; text: string; limit: number }> {
  const fields: Array<{ where: string; text: string; limit: number }> = [];
  for (const key of ['title', 'submit', 'close'] as const) {
    if (view[key]) {
      fields.push({
        where: key,
        text: view[key].text,
        limit: key === 'title' ? SLACK_LIMITS.title : SLACK_LIMITS.button,
      });
    }
  }
  for (const block of view.blocks ?? []) {
    const element = block.element;
    if (element?.placeholder) {
      fields.push({
        where: `${block.block_id}.placeholder`,
        text: element.placeholder.text,
        limit: SLACK_LIMITS.placeholder,
      });
    }
    for (const option of element?.options ?? []) {
      fields.push({ where: `${block.block_id}.option`, text: option.text.text, limit: SLACK_LIMITS.option });
      if (option.description) {
        fields.push({
          where: `${block.block_id}.option.description`,
          text: option.description.text,
          limit: SLACK_LIMITS.option,
        });
      }
    }
  }
  return fields;
}

describe('repository selection views in Korean', () => {
  const t = createT('ko');
  const views = {
    loading: buildRepositoryLoadingView(t, METADATA),
    selection: buildRepositorySelectionView(t, METADATA, repoOptions(t)),
    empty: buildRepositoryEmptyView(t, METADATA),
  };

  it('speaks Korean in every modal', () => {
    for (const [name, view] of Object.entries(views)) {
      expect([name, HANGUL.test(JSON.stringify(view))]).toEqual([name, true]);
      expect([name, view.title.text]).toEqual([name, '저장소 선택']);
    }
    expect(views.selection.submit.text).toBe('저장소 연결');
    expect(views.loading.close.text).toBe('취소');
    expect(views.empty.close.text).toBe('닫기');
  });

  it('keeps the block structure the handlers key off untouched', () => {
    expect(views.selection.callback_id).toBe('select_repository_modal');
    expect(views.selection.blocks.map((block: any) => block.block_id)).toEqual([
      undefined,
      'repository_select_block',
      'repository_url_block',
      'path_input_block',
    ]);
    expect(views.selection.blocks[1].element.action_id).toBe('repository_select');
    expect(views.selection.private_metadata).toBe('{"userId":"U1","workspaceId":"T1"}');
  });

  it('keeps the URL example out of the catalog and in the placeholder', () => {
    expect(views.selection.blocks[2].element.placeholder.text).toBe(
      'https://github.com/owner/repo 또는 /tree/branch/docs',
    );
  });

  it('fits every capped field inside its Slack limit', () => {
    for (const view of Object.values(views)) {
      for (const field of cappedFields(view)) {
        expect({ ...field, withinLimit: field.text.length <= field.limit }).toEqual({ ...field, withinLimit: true });
      }
    }
  });

  it('truncates a long repository name to 75 characters in Korean too', () => {
    const label = formatRepositoryOptionText(t, {
      full_name: 'an-extremely-long-github-organization-name/an-equally-long-repository-name-here',
      markdownStats: { markdownFiles: 128 },
    });
    expect(label.length).toBeLessThanOrEqual(SLACK_LIMITS.option);
    expect(label.endsWith('...')).toBe(true);
  });

  it('keeps a long runtime option description inside the option cap', () => {
    const description = t('appHome.github.repoPicker.option.description', {
      count: 123456,
      percent: '99.9',
      total: 987654,
    });
    expect(HANGUL.test(description)).toBe(true);
    expect(description.length).toBeLessThanOrEqual(SLACK_LIMITS.option);
  });
});

// ---------------------------------------------------------------------------
// Index management, narrated in the clicker's language
// ---------------------------------------------------------------------------

describe('reload from GitHub for a Korean actor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    initialize.mockResolvedValue(true);
    getAllMarkdownFiles.mockResolvedValue([
      { name: 'a.md', path: 'docs/a.md', content: '# a' },
      { name: 'b.md', path: 'docs/b.md', content: '# b' },
      { name: 'c.md', path: 'docs/c.md', content: '# c' },
    ]);
  });

  async function run(locale: 'en' | 'ko') {
    const postMessage = jest.fn(async () => ({ ok: true }));
    await reloadFromGithubAction({
      ack: jest.fn(async () => undefined),
      client: { chat: { postMessage } },
      body: { user: { id: 'U1' } },
      context: { locale },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    } as any);
    return postMessage.mock.calls.map((call: any[]) => call[0]);
  }

  it('sends the progress line and the result in Korean', async () => {
    const posts = await run('ko');

    expect(posts.map((post: any) => post.text)).toEqual([
      '🔄 GitHub에서 파일을 다시 불러오고 있어요...',
      '✅ GitHub에서 파일 3개를 다시 불러오고 벡터 스토어를 업데이트했어요!',
    ]);
    // The fallback text and the block a Slack client actually renders must not
    // disagree — they are the same key, resolved once per message.
    for (const post of posts) {
      expect(post.blocks[0].text.text).toBe(post.text);
    }
  });

  it('still sends English, byte for byte, to an English actor', async () => {
    const posts = await run('en');

    expect(posts.map((post: any) => post.text)).toEqual([
      '🔄 Reloading files from GitHub...',
      '✅ Successfully reloaded 3 files from GitHub and updated vector store!',
    ]);
  });
});
