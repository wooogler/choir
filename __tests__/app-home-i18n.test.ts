// The App Home root and management surfaces after the catalog migration.
//
// Two things are being protected here. English must not have moved: every block
// and modal is compared against `fixtures/app-home-en.json`, captured from the
// pre-migration builders, so a reworded catalog entry or a dropped emoji fails
// loudly (the plural fixes are exercised at counts where English is unchanged;
// the one-item wording is asserted separately). And Korean must actually fit:
// Slack rejects a whole view when a modal title runs past 24 characters, so the
// same blocks are rendered with `createT('ko')` and every length-capped field is
// measured.

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

import {
  buildBecomeManagerBlocks,
  buildHomeView,
  buildInsightsBlocks,
  buildLogDownloadBlocks,
  buildLoggingToggleBlocks,
  buildOrganizationNameBlocks,
} from '../listeners/features/app-home/home-view-builder';
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

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'app-home-en.json'), 'utf-8')) as Record<
  string,
  any
>;

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

beforeEach(() => {
  jest.clearAllMocks();
  state.locale = 'en';
  state.isManager = true;
  state.isOwner = false;
  process.env.SLACK_APP_ID = 'A123';
  process.env.DOCS_BASE_URL = 'https://docs.example.com';
  process.env.OPENAI_API_KEY = '';
});

describe('English is byte-identical to the pre-migration output', () => {
  it('renders the manager home view exactly as before', async () => {
    const client = makeClient([], []);

    expect(await buildHomeView(client, logger, 'T1', 'U1')).toEqual(fixtures.homeManager);
  });

  it('renders the non-manager home view exactly as before', async () => {
    state.isManager = false;
    const client = makeClient([], []);

    expect(await buildHomeView(client, logger, 'T1', 'U3')).toEqual(fixtures.homeMember);
  });

  it('opens every management modal exactly as before', async () => {
    const modals = await openModals('en');

    for (const [name, view] of Object.entries(modals)) {
      expect([name, view]).toEqual([name, fixtures[name]]);
    }
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

  it('speaks Korean across the whole manager home view', async () => {
    state.locale = 'ko';
    const client = makeClient([], []);

    const blocks = await buildHomeView(client, logger, 'T1', 'U1');
    const rendered = JSON.stringify(blocks);

    expect(hasHangul(rendered)).toBe(true);
    // Every English section heading is gone, not just the first one.
    expect(rendered).not.toContain(en('appHome.choirManagement.header'));
    expect(rendered).not.toContain(en('appHome.logs.header'));
    expect(rendered).not.toContain(en('appHome.readOnly.header'));
    expect(rendered).toContain(ko('appHome.choirManagement.header'));
    expect(rendered).toContain(ko('appHome.logs.header'));
    expectWithinLimits(blocks);
  });

  it('speaks Korean in the non-manager home view too', async () => {
    state.locale = 'ko';
    state.isManager = false;
    const client = makeClient([], []);

    const blocks = await buildHomeView(client, logger, 'T1', 'U3');
    const rendered = JSON.stringify(blocks);

    expect(rendered).toContain(ko('appHome.becomeManager.button'));
    expect(rendered).not.toContain(en('appHome.becomeManager.button'));
    // The manager-only sections stay hidden, in any language.
    expect(rendered).not.toContain(ko('appHome.choirManagement.header'));
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

  it('renders the exported pure builders in the reader’s language', () => {
    const organization = buildOrganizationNameBlocks(ko, true, false, 'Acme Labs');
    const logs = buildLogDownloadBlocks(ko, true, false);
    const logging = buildLoggingToggleBlocks(ko, true, false, true);
    const insights = buildInsightsBlocks(ko, 'T1', true);
    const becomeManager = buildBecomeManagerBlocks(ko, false, false);

    expect(organization[0].text.text).toBe(ko('appHome.organization.header'));
    expect(logs[2].elements[0].text.text).toBe(ko('appHome.logs.today.button'));
    expect(logging[2].elements[0].text.text).toBe(ko('appHome.logging.disable.button'));
    expect(insights[1].elements[0].text.text).toBe(ko('appHome.insights.open.button'));
    expect(becomeManager[1].elements[0].text.text).toBe(ko('appHome.becomeManager.button'));

    for (const blocks of [organization, logs, logging, insights, becomeManager]) {
      expectWithinLimits(blocks);
    }
  });

  it('hides the manager-only builders from a plain member, in Korean', () => {
    expect(buildOrganizationNameBlocks(ko, false, false, 'Acme Labs')).toEqual([]);
    expect(buildLogDownloadBlocks(ko, false, false)).toEqual([]);
    expect(buildLoggingToggleBlocks(ko, false, false, true)).toEqual([]);
    expect(buildBecomeManagerBlocks(ko, true, false)).toEqual([]);
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
