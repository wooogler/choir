// The App Home root and management surfaces.
//
// Three things are being protected here. The redesigned layout must not drift:
// every tab's blocks and every modal are compared against
// `fixtures/app-home-en.json`, so a reworded catalog entry, a dropped emoji, a
// vanished accessory or a second green button fails loudly (the plural fixes are
// exercised at counts where English is unchanged; the one-item wording is
// asserted separately). The tab structure itself is checked — a member gets no
// tab bar and no manager rows, and each tab carries at most one `primary` button
// outside the bar. And Korean must actually fit: Slack rejects a whole view when
// a modal title runs past 24 characters, so every tab is rendered again with
// `createT('ko')` and each length-capped field is measured.

import * as fs from 'node:fs';
import * as path from 'node:path';

const state: any = {
  locale: 'en',
  isManager: true,
  isOwner: false,
  managers: ['UM1', 'UM2'],
  choirUsers: ['UM1', 'UM2', 'U3'],
  organizationName: 'Acme Labs',
  qaChannel: 'C_QA',
  githubRepo: { url: 'https://github.com/acme/docs', owner: 'acme', repo: 'docs', path: 'docs' },
  userGithubInfo: {
    user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
    connectedAt: { toLocaleDateString: () => '1/2/2025' },
  },
  loggingEnabled: true,
  readOnlyFiles: ['docs/a.md'],
  markdownFiles: [
    { name: 'a.md', path: 'docs/a.md' },
    { name: 'b.md', path: 'docs/b.md' },
  ],
  workspaceConfig: { githubRepo: { owner: 'acme', repo: 'docs' } },
  openAISettings: { apiKey: 'sk-abcdefghijklmnop', qaModel: 'gpt-5.4', documentUpdateModel: 'gpt-5.4' },
  contextKeyStatus: { configured: true, createdAt: '2025-01-02T03:04:05.000Z', rotatedAt: '2025-03-04T05:06:07.000Z' },
};

// `services/i18n` is stubbed rather than required-actual so the resolver (the
// handlers' only network-ish dependency) is controllable, while `tForRequest`
// stays faithful — which language a handler answers in is what is under test.
jest.mock('services/i18n', () => {
  const { createT, isSupportedLocale } = jest.requireActual('../src/i18n');
  return {
    resolveLocaleForUser: jest.fn(async () => state.locale),
    tForRequest: (context: any) => createT(isSupportedLocale(context?.locale) ? context.locale : 'en'),
    tForUser: async () => createT(state.locale),
  };
});

jest.mock('services/slack', () => ({
  getCHOIRUsers: jest.fn(async () => state.choirUsers),
  getGithubRepo: jest.fn(async () => state.githubRepo),
  getManagers: jest.fn(async () => state.managers),
  getOrganizationName: jest.fn(async () => state.organizationName),
  getQAChannel: jest.fn(async () => state.qaChannel),
  isManager: jest.fn(async () => state.isManager),
  isWorkspaceOwner: jest.fn(async () => state.isOwner),
  getWorkspaceId: jest.fn(async () => 'T1'),
  setOrganizationName: jest.fn(async () => undefined),
  addManager: jest.fn(async () => true),
  removeManager: jest.fn(async () => true),
  setQAChannel: jest.fn(async () => undefined),
  setCHOIRUsers: jest.fn(async () => true),
  clearRegistrationRequest: jest.fn(),
  promoteToManagerWithPassword: jest.fn(async () => true),
}));

jest.mock('services/workspace/workspace-store', () => ({
  WorkspaceStore: jest.fn().mockImplementation(() => ({
    getUserGithubInfo: jest.fn(async () => state.userGithubInfo),
    getLoggingEnabled: jest.fn(async () => state.loggingEnabled),
    getUserLanguage: jest.fn(async () => null),
    getWorkspaceLanguage: jest.fn(async () => 'en'),
    getContentLanguage: jest.fn(async () => 'follow-conversation'),
    getReadOnlyFiles: jest.fn(async () => state.readOnlyFiles),
    getCachedMarkdownFiles: jest.fn(async () => state.markdownFiles),
    getWorkspaceConfig: jest.fn(async () => state.workspaceConfig),
    getOpenAISettings: jest.fn(async () => state.openAISettings),
    getContextKeyStatus: jest.fn(async () => state.contextKeyStatus),
    getContextEncryptionKey: jest.fn(async () => Buffer.alloc(32, 7)),
    setReadOnlyFiles: jest.fn(async () => true),
  })),
}));

jest.mock('services/common/interaction-tracker', () => ({
  logAppHomeButtonClick: jest.fn(async () => undefined),
  logAppHomeModalSubmit: jest.fn(async () => undefined),
}));

jest.mock('../listeners/features/app-home/refresh', () => ({
  refreshAppHome: jest.fn(),
  refreshAppHomeSoon: jest.fn(),
}));

import { type HomeTab, resetHomeTabsForTests, setActiveTab } from '../listeners/features/app-home/home-tabs';
import { buildHomeView } from '../listeners/features/app-home/home-view-builder';
import { registerChoirUsersHandlers } from '../listeners/features/app-home/management/choir-users-handlers';
import { registerContextKeyHandlers } from '../listeners/features/app-home/management/context-key-handlers';
import { registerManagerPromotionHandlers } from '../listeners/features/app-home/management/manager-promotion-handlers';
import { registerManagersHandlers } from '../listeners/features/app-home/management/managers-handlers';
import { registerOpenAISettingsHandlers } from '../listeners/features/app-home/management/openai-settings-handlers';
import { registerReadonlyFilesHandlers } from '../listeners/features/app-home/management/readonly-files-handlers';
import { registerOrganizationHandlers } from '../listeners/features/app-home/organization-handlers';
import { createT } from '../src/i18n';

const en = createT('en');
const ko = createT('ko');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'app-home-en.json');
const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, any>;

/**
 * Compares a rendered view with its recorded fixture — or, when the layout has
 * been changed on purpose, re-records it: `UPDATE_FIXTURES=1 pnpm test
 * app-home-i18n` rewrites the file, and the diff is the review.
 */
const matchFixture = (name: string, rendered: unknown) => {
  if (process.env.UPDATE_FIXTURES) {
    fixtures[name] = rendered;
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixtures, null, 2)}\n`);
    return;
  }
  expect([name, rendered]).toEqual([name, fixtures[name]]);
};

const logger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const makeClient = (opened: any[], posted: any[]) =>
  ({
    auth: { test: jest.fn(async () => ({ team_id: 'T1', user_id: 'UBOT', team: 'Acme' })) },
    team: { info: jest.fn(async () => ({ team: { name: 'Acme' } })) },
    users: {
      info: jest.fn(async ({ user }: any) => ({ user: { real_name: `Real ${user}`, name: `handle_${user}` } })),
    },
    conversations: {
      info: jest.fn(async () => ({ channel: { name: 'qa-channel' } })),
      open: jest.fn(async () => ({ channel: { id: 'D1' } })),
    },
    views: { open: jest.fn(async ({ view }: any) => opened.push(view)), publish: jest.fn(async () => ({})) },
    chat: {
      postEphemeral: jest.fn(async (message: any) => posted.push(message)),
      postMessage: jest.fn(async (message: any) => posted.push(message)),
    },
  }) as any;

/** Renders one manager tab by parking the viewer on it first. */
const renderTab = async (tab: HomeTab, userId = 'U1') => {
  setActiveTab('T1', userId, tab);
  return buildHomeView(makeClient([], []), logger, 'T1', userId);
};

const collect = (register: (app: any) => void) => {
  const handlers = new Map<string, any>();
  register({
    action: (id: string, fn: any) => handlers.set(`action:${id}`, fn),
    view: (id: string, fn: any) => handlers.set(`view:${id}`, fn),
    options: (id: string, fn: any) => handlers.set(`options:${id}`, fn),
  });
  return handlers;
};

/** Opens every migrated modal once and returns the views Slack would receive. */
const openModals = async (locale: string) => {
  const opened: any[] = [];
  const posted: any[] = [];
  const client = makeClient(opened, posted);
  const args = {
    ack: jest.fn(async () => undefined),
    body: { user: { id: 'U1' }, trigger_id: 'TRIG' },
    client,
    context: { locale },
    logger,
  };

  const open = async (register: (app: any) => void, actionId: string) => {
    await collect(register).get(`action:${actionId}`)(args);
    return opened.pop();
  };

  return {
    modalEditOrganizationName: await open(registerOrganizationHandlers, 'edit_organization_name'),
    modalManagers: await open(registerManagersHandlers, 'manage_managers'),
    modalChoirUsers: await open(registerChoirUsersHandlers, 'manage_choir_users'),
    modalReadonlyFiles: await open(registerReadonlyFilesHandlers, 'manage_readonly_files'),
    modalManagerPromotion: await open(registerManagerPromotionHandlers, 'request_manager_permission'),
    modalRotateKey: await open(registerContextKeyHandlers, 'rotate_context_key'),
    modalImportKey: await open(registerContextKeyHandlers, 'import_context_key'),
    modalBackupKey: await open(registerContextKeyHandlers, 'backup_context_key'),
    modalOpenAISettings: await open(registerOpenAISettingsHandlers, 'configure_openai'),
  };
};

/** Every button in a block list that Slack would paint green. */
const primaryButtons = (blocks: any[]) =>
  blocks.flatMap((block: any) =>
    [block.accessory, ...(block.elements ?? [])].filter(
      (element: any) => element?.type === 'button' && element.style === 'primary',
    ),
  );

/** The tab bar, when there is one: the actions block of `home_tab:` buttons. */
const tabBarOf = (blocks: any[]) =>
  blocks.find((block: any) => block.elements?.some?.((element: any) => element.action_id?.startsWith('home_tab:')));

const actionIdsOf = (blocks: any[]): string[] =>
  JSON.stringify(blocks)
    .match(/"action_id":"([^"]+)"/g)
    ?.map((match) => match.slice(13, -1)) ?? [];

beforeEach(() => {
  jest.clearAllMocks();
  resetHomeTabsForTests();
  state.locale = 'en';
  state.isManager = true;
  state.isOwner = false;
  state.qaChannel = 'C_QA';
  state.userGithubInfo = {
    user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
    connectedAt: { toLocaleDateString: () => '1/2/2025' },
  };
  process.env.SLACK_APP_ID = 'A123';
  process.env.DOCS_BASE_URL = 'https://docs.example.com';
  process.env.OPENAI_API_KEY = '';
  process.env.MANAGER_PROMOTION_PASSWORD = 'secret';
  state.contextKeyStatus = {
    configured: true,
    createdAt: '2025-01-02T03:04:05.000Z',
    rotatedAt: '2025-03-04T05:06:07.000Z',
  };
});

describe('English matches the recorded layout', () => {
  it('renders the manager home tab', async () => {
    matchFixture('homeManager', await buildHomeView(makeClient([], []), logger, 'T1', 'U1'));
  });

  it('renders the non-manager home tab', async () => {
    state.isManager = false;

    matchFixture('homeMember', await buildHomeView(makeClient([], []), logger, 'T1', 'U3'));
  });

  it('renders the Documents tab', async () => {
    matchFixture('homeManagerDocuments', await renderTab('documents'));
  });

  it('renders the Team tab', async () => {
    matchFixture('homeManagerTeam', await renderTab('team'));
  });

  it('renders the Advanced tab', async () => {
    matchFixture('homeManagerAdvanced', await renderTab('advanced'));
  });

  it('opens every management modal exactly as before', async () => {
    const modals = await openModals('en');

    for (const [name, view] of Object.entries(modals)) {
      matchFixture(name, view);
    }
  });
});

describe('tab structure', () => {
  const managerTabs: HomeTab[] = ['home', 'documents', 'team', 'advanced'];

  it('gives a manager a bar of all four tabs with the active one marked', async () => {
    for (const tab of managerTabs) {
      const bar = tabBarOf(await renderTab(tab));

      expect(bar.elements.map((element: any) => element.action_id)).toEqual([
        'home_tab:home',
        'home_tab:documents',
        'home_tab:team',
        'home_tab:advanced',
      ]);
      expect(bar.elements.filter((element: any) => element.style === 'primary')).toHaveLength(1);
      expect(bar.elements.find((element: any) => element.style === 'primary').action_id).toBe(`home_tab:${tab}`);
    }
  });

  it('gives a member no tab bar and no manager rows', async () => {
    state.isManager = false;
    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U3');

    expect(tabBarOf(blocks)).toBeUndefined();
    expect(actionIdsOf(blocks)).toEqual([
      'start_chat_url',
      'open_docs_url',
      'open_dashboard_url',
      'set_my_language',
      'request_manager_permission',
    ]);
  });

  it('sends a member who somehow stored a manager tab back to Home', async () => {
    state.isManager = false;
    setActiveTab('T1', 'U3', 'advanced');

    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U3');

    expect(actionIdsOf(blocks)).not.toContain('toggle_logging');
    expect(actionIdsOf(blocks)).toContain('start_chat_url');
  });

  it('paints at most one green button per tab, outside the bar', async () => {
    for (const tab of managerTabs) {
      const blocks = await renderTab(tab);
      const content = blocks.filter((block: any) => block !== tabBarOf(blocks));

      expect([tab, primaryButtons(content).length]).toEqual([tab, tab === 'home' ? 1 : 0]);
    }
  });

  it('never repeats an action_id inside one block', async () => {
    for (const tab of managerTabs) {
      for (const block of await renderTab(tab)) {
        const ids = (block.elements ?? []).map((element: any) => element.action_id).filter(Boolean);
        expect([tab, ids.length]).toEqual([tab, new Set(ids).size]);
      }
    }
  });
});

describe('controls that would lead nowhere are not drawn', () => {
  it('drops the Manager Access button when no promotion password is configured', async () => {
    state.isManager = false;
    process.env.MANAGER_PROMOTION_PASSWORD = '';

    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U3');
    const hint = blocks.find((block: any) => block.text?.text === en('appHome.becomeManager.hint'));

    expect(hint).toBeDefined();
    expect(hint.accessory).toBeUndefined();
    expect(actionIdsOf(blocks)).not.toContain('request_manager_permission');
  });

  it('shows the workspace repository to a manager whose own GitHub is not connected, without a Change button', async () => {
    state.userGithubInfo = null;

    const home = await buildHomeView(makeClient([], []), logger, 'T1', 'U1');
    const summary = home.find((block: any) => block.text?.text?.startsWith(en('appHome.home.setup.label')));
    expect(summary.text.text).toContain(en('appHome.home.setup.repo.done', { repo: 'acme/docs (Path: docs)' }));
    expect(actionIdsOf(home)).not.toContain('browse_github_repositories');

    const documents = await renderTab('documents');
    const repoRow = documents.find((block: any) => block.text?.text?.startsWith('*Repository*'));
    expect(repoRow.text.text).toContain('acme/docs');
    expect(repoRow.accessory).toBeUndefined();
    expect(actionIdsOf(documents)).toContain('connect_personal_github');
    expect(actionIdsOf(documents)).not.toContain('browse_github_repositories');
  });

  it('keeps the rotation warning and key buttons for a key that exists, and hides them before one does', async () => {
    const withKey = await renderTab('advanced');
    expect(JSON.stringify(withKey)).toContain(en('appHome.contextKey.warning'));
    expect(actionIdsOf(withKey)).toEqual(expect.arrayContaining(['backup_context_key', 'rotate_context_key']));

    state.contextKeyStatus = { configured: false };
    const withoutKey = await renderTab('advanced');
    expect(JSON.stringify(withoutKey)).not.toContain(en('appHome.contextKey.warning'));
    expect(actionIdsOf(withoutKey)).toContain('import_context_key');
    expect(actionIdsOf(withoutKey)).not.toContain('rotate_context_key');
  });
});

describe('Home setup card', () => {
  it('collapses configured lines into one section', async () => {
    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U1');
    const setup = blocks.find((block: any) => block.text?.text?.startsWith(en('appHome.home.setup.label')));

    expect(setup.text.text).toContain(en('appHome.home.setup.github.done', { login: 'octocat' }));
    expect(setup.text.text).toContain(en('appHome.home.setup.channel.done', { channel: 'qa-channel' }));
    expect(setup.accessory).toBeUndefined();
  });

  it('turns an unset Q&A channel into its own row with the channel picker', async () => {
    state.qaChannel = null;
    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U1');
    const summary = blocks.find((block: any) => block.text?.text?.startsWith(en('appHome.home.setup.label')));
    const fix = blocks.find((block: any) => block.text?.text === en('appHome.home.setup.channel.todo'));

    // The configured lines stay collapsed; only the unset one becomes a row.
    expect(summary.text.text).toContain(en('appHome.home.setup.github.done', { login: 'octocat' }));
    expect(summary.text.text).not.toContain('Q&A');
    expect(fix.accessory).toMatchObject({ type: 'channels_select', action_id: 'select_qa_channel' });
    expect(fix.accessory.initial_channel).toBeUndefined();
  });

  it('makes Connect GitHub the green button while setup is unfinished', async () => {
    state.userGithubInfo = null;
    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U1');
    const content = blocks.filter((block: any) => block !== tabBarOf(blocks));

    expect(primaryButtons(content).map((button: any) => button.action_id)).toEqual(['connect_personal_github']);
  });
});

describe('Korean rendering', () => {
  const hasHangul = (value: string) => /[가-힣]/.test(value);

  /** Every string Slack length-caps, paired with the cap that applies to it. */
  const cappedStrings = (node: any, limits: Array<{ text: string; limit: number; where: string }> = [], where = '') => {
    if (!node || typeof node !== 'object') return limits;
    if (Array.isArray(node)) {
      for (const item of node) cappedStrings(item, limits, where);
      return limits;
    }

    const push = (text: unknown, limit: number, label: string) => {
      if (typeof text === 'string') limits.push({ text, limit, where: `${where}${label}` });
    };

    if (node.type === 'modal') {
      push(node.title?.text, 24, 'modal.title');
      push(node.submit?.text, 75, 'modal.submit');
      push(node.close?.text, 75, 'modal.close');
    }
    if (node.type === 'header') push(node.text?.text, 150, 'header');
    if (node.type === 'button') push(node.text?.text, 75, 'button');
    if (node.type === 'plain_text' && node.emoji !== undefined) push(node.text, 3000, 'plain_text');
    if (node.type === 'mrkdwn') push(node.text, 3000, 'mrkdwn');
    if (node.placeholder) push(node.placeholder.text, 150, 'placeholder');
    if (node.options) for (const option of node.options) push(option.text?.text, 75, 'option');
    if (node.initial_option) push(node.initial_option.text?.text, 75, 'option');
    if (node.confirm?.title) {
      push(node.confirm.title.text, 100, 'confirm.title');
      push(node.confirm.text?.text, 300, 'confirm.text');
      push(node.confirm.confirm?.text, 30, 'confirm.confirm');
      push(node.confirm.deny?.text, 30, 'confirm.deny');
    }
    if (node.label) push(node.label.text, 2000, 'label');
    if (node.hint) push(node.hint.text, 2000, 'hint');

    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'object') cappedStrings(value, limits, `${where}${key}.`);
    }
    return limits;
  };

  const expectWithinLimits = (blocks: any) => {
    for (const { text, limit, where } of cappedStrings(blocks)) {
      expect({ where, text, over: text.length > limit }).toEqual({ where, text, over: false });
    }
  };

  it('speaks Korean on every manager tab, within Slack’s limits', async () => {
    state.locale = 'ko';

    for (const tab of ['home', 'documents', 'team', 'advanced'] as HomeTab[]) {
      const blocks = await renderTab(tab);
      const rendered = JSON.stringify(blocks);

      expect([tab, hasHangul(rendered)]).toEqual([tab, true]);
      expect(rendered).toContain(ko(`appHome.tabs.${tab}` as 'appHome.tabs.home'));
      expectWithinLimits(blocks);
    }
  });

  it('translates the rows English used to own outright', async () => {
    state.locale = 'ko';

    const documents = JSON.stringify(await renderTab('documents'));
    expect(documents).toContain(ko('appHome.documents.repo.change.button'));
    expect(documents).not.toContain(en('appHome.documents.repo.change.button'));

    const advanced = await renderTab('advanced');
    const loggingRow = advanced.find((block: any) => block.accessory?.action_id === 'toggle_logging');
    expect(loggingRow.text.text).toBe(ko('appHome.advanced.logging.enabled'));
    expect(loggingRow.accessory.text.text).toBe(ko('appHome.logging.disable.button'));
  });

  it('speaks Korean in the non-manager home view too', async () => {
    state.locale = 'ko';
    state.isManager = false;

    const blocks = await buildHomeView(makeClient([], []), logger, 'T1', 'U3');
    const rendered = JSON.stringify(blocks);

    expect(rendered).toContain(ko('appHome.becomeManager.button'));
    expect(rendered).not.toContain(en('appHome.becomeManager.button'));
    // The manager-only rows stay hidden, in any language.
    expect(rendered).not.toContain(ko('appHome.home.setup.label'));
    expectWithinLimits(blocks);
  });

  it('keeps every Korean modal within Slack’s field limits', async () => {
    state.locale = 'ko';
    const modals = await openModals('ko');

    for (const [name, view] of Object.entries(modals)) {
      expect([name, hasHangul(JSON.stringify(view))]).toEqual([name, true]);
      expectWithinLimits(view);
    }
    // The two 22-character English titles are the ones that could overflow.
    expect(modals.modalEditOrganizationName.title.text.length).toBeLessThanOrEqual(24);
    expect(modals.modalReadonlyFiles.title.text.length).toBeLessThanOrEqual(24);
  });
});

describe('manager gate', () => {
  it('denies in the actor’s own language', async () => {
    state.isManager = false;
    state.isOwner = false;
    const opened: any[] = [];
    const posted: any[] = [];
    const client = makeClient(opened, posted);

    await collect(registerChoirUsersHandlers).get('action:manage_choir_users')({
      ack: jest.fn(async () => undefined),
      body: { user: { id: 'U9' }, trigger_id: 'TRIG' },
      client,
      context: { locale: 'ko' },
      logger,
    });

    expect(opened).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toBe(ko('appHome.management.error.permissionDenied'));
    expect(posted[0].text).not.toBe(en('appHome.management.error.permissionDenied'));
  });

  it('falls back to English for an actor with no locale on the request', async () => {
    state.isManager = false;
    state.isOwner = false;
    const posted: any[] = [];
    const client = makeClient([], posted);

    await collect(registerReadonlyFilesHandlers).get('action:manage_readonly_files')({
      ack: jest.fn(async () => undefined),
      body: { user: { id: 'U9' }, trigger_id: 'TRIG' },
      client,
      context: {},
      logger,
    });

    expect(posted[0].text).toBe(en('appHome.management.error.permissionDenied'));
  });
});

describe('counted strings', () => {
  it('uses the singular wording English never had before', () => {
    expect(en('appHome.management.managers.status', { count: 1 })).toContain('1 manager assigned');
    expect(en('appHome.management.managers.status', { count: 2 })).toContain('2 managers assigned');
    expect(en('appHome.management.choirUsers.status', { count: 1 })).toContain('1 user registered');
    expect(en('appHome.management.readOnly.updated', { count: 1 })).toContain('1 file is now marked');
    expect(en('appHome.management.managers.updated', { count: 1, changes: '' })).toContain('1 manager is now assigned');
  });

  it('counts in Korean without inflecting the noun', () => {
    expect(ko('appHome.management.managers.status', { count: 1 })).toBe(
      ko('appHome.management.managers.status', { count: 2 }).replace('2', '1'),
    );
  });
});
