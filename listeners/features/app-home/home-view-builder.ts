/**
 * The App Home view: a tab bar plus the blocks of exactly one tab.
 *
 * The layout rules are written down in `docs/app-home.md`; the ones that shape
 * this file are: a setting is one `section` row with a bold label, a one-line
 * status and a single accessory control; `primary` marks the one thing to do
 * next (the tab bar's active-tab marker aside); and only the active tab is
 * built, so rendering Advanced never pays for Team's roster lookups.
 */

import type { Logger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { resolveLocaleForUser } from 'services/i18n';
import {
  getCHOIRUsers,
  getGithubRepo,
  getManagers,
  getOrganizationName,
  getQAChannel,
  isManager,
  isWorkspaceOwner,
} from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { type Locale, type T, createT } from '../../../src/i18n';
import { HOME_TABS, type HomeTab, getActiveTab } from './home-tabs';

/** Number of read-only file names spelled out before the list is summarised. */
const READ_ONLY_PREVIEW = 5;

type Block = Record<string, any>;

/** One setting: a bold label, a one-line status, and at most one control. */
const row = (text: string, accessory?: Block): Block => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
  ...(accessory ? { accessory } : {}),
});

const button = (label: string, actionId: string, extra: Block = {}): Block => ({
  type: 'button',
  text: { type: 'plain_text', text: label, emoji: true },
  action_id: actionId,
  ...extra,
});

/**
 * A `confirm` dialog. The three texts are passed already translated rather than
 * assembled from a key prefix, because `t` only type-checks literal keys.
 */
const confirm = (t: T, title: string, body: string, ok: string): Block => ({
  confirm: {
    title: { type: 'plain_text', text: title },
    text: { type: 'plain_text', text: body },
    confirm: { type: 'plain_text', text: ok },
    deny: { type: 'plain_text', text: t('common.button.cancel') },
  },
});

const actions = (elements: Block[]): Block => ({ type: 'actions', elements });

const context = (text: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

const divider: Block = { type: 'divider' };

export const buildHomeView = async (
  client: WebClient,
  logger: Logger,
  workspaceId: string,
  userId: string,
): Promise<any[]> => {
  const [isUserManager, isOwner] = await Promise.all([
    isManager(workspaceId, userId),
    isWorkspaceOwner(userId, client),
  ]);
  const canManage = isUserManager || isOwner;

  // The network-resolving variant is deliberate here: rendering Home already
  // costs a `users.info`, and resolving now warms the locale cache for every
  // cheap (`...Cached`) lookup this person's next interactions will do. It runs
  // before any block is built because every builder below reads from `t`.
  const locale = await resolveLocaleForUser(workspaceId, userId, client);
  const t = createT(locale);

  const activeTab = getActiveTab(workspaceId, userId, { isManager: canManage });
  const tabBar = buildTabBar(t, activeTab, canManage);

  switch (activeTab) {
    case 'documents':
      return [...tabBar, ...(await buildDocumentsTab(t, locale, workspaceId, userId))];
    case 'team':
      return [...tabBar, ...(await buildTeamTab(t, client, logger, workspaceId))];
    case 'advanced':
      return [...tabBar, ...(await buildAdvancedTab(t, workspaceId))];
    default:
      return [...tabBar, ...(await buildHomeTab(t, locale, client, logger, workspaceId, userId, canManage))];
  }
};

/**
 * The tab bar. Members never see it — Home is their only tab — so for them the
 * view starts straight at the welcome row.
 */
export const buildTabBar = (t: T, activeTab: HomeTab, canManage: boolean): any[] => {
  if (!canManage) return [];

  return [
    actions(
      HOME_TABS.map((tab) =>
        button(t(TAB_LABEL_KEYS[tab]), `home_tab:${tab}`, tab === activeTab ? { style: 'primary' } : {}),
      ),
    ),
  ];
};

/** Spelled out rather than built from the tab name so `t` keeps checking the keys. */
const TAB_LABEL_KEYS = {
  home: 'appHome.tabs.home',
  documents: 'appHome.tabs.documents',
  team: 'appHome.tabs.team',
  advanced: 'appHome.tabs.advanced',
} as const;

// --- 🏠 Home ---------------------------------------------------------------

const buildHomeTab = async (
  t: T,
  locale: Locale,
  client: WebClient,
  logger: Logger,
  workspaceId: string,
  userId: string,
  canManage: boolean,
): Promise<any[]> => {
  const workspaceStore = new WorkspaceStore();
  const [authTest, userLanguage, choirUsers] = await Promise.all([
    client.auth.test(),
    workspaceStore.getUserLanguage(workspaceId, userId),
    getCHOIRUsers(workspaceId),
  ]);

  // The setup card is built first: whether anything in it still needs doing is
  // what decides if "Start chatting" is the green button or a plain one.
  const setupBlocks = canManage
    ? await buildSetupBlocks(t, client, logger, workspaceId, userId, choirUsers)
    : { blocks: [] as Block[], incomplete: false };

  const elements: Block[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: t('appHome.welcome.startChat.button'), emoji: true },
      action_id: 'start_chat_url',
      url: startChatUrl(logger, authTest),
      ...(setupBlocks.incomplete ? {} : { style: 'primary' }),
    },
  ];

  const dashboardUrl = teamInsightsUrl(workspaceId, choirUsers.includes(userId));
  if (dashboardUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: t('appHome.insights.open.button'), emoji: true },
      action_id: 'open_dashboard_url',
      url: dashboardUrl,
    });
  }

  const blocks: Block[] = [
    row(t('appHome.welcome.greeting', { user: `<@${userId}>` })),
    row(t('appHome.welcome.intro')),
    actions(elements),
    divider,
    buildMyLanguageRow(t, userLanguage),
    divider,
  ];

  if (canManage) {
    blocks.push(...setupBlocks.blocks);
  } else {
    blocks.push(
      row(t('appHome.becomeManager.hint'), button(t('appHome.becomeManager.button'), 'request_manager_permission')),
    );
  }

  return blocks;
};

/**
 * The manager's setup card: every configured piece collapses into one summary
 * section, and every unconfigured one becomes its own row carrying the control
 * that fixes it. `incomplete` tells the caller whether a green button is
 * already spoken for.
 */
const buildSetupBlocks = async (
  t: T,
  client: WebClient,
  logger: Logger,
  workspaceId: string,
  userId: string,
  choirUsers: string[],
): Promise<{ blocks: Block[]; incomplete: boolean }> => {
  const workspaceStore = new WorkspaceStore();
  const [userGithubInfo, repoInfo, qaChannelId, managers] = await Promise.all([
    workspaceStore.getUserGithubInfo(workspaceId, userId),
    getGithubRepo(workspaceId),
    getQAChannel(workspaceId, client),
    getManagers(workspaceId),
  ]);
  const qaChannelName = await resolveChannelName(client, logger, qaChannelId);

  const done: string[] = [];
  const fixes: Block[] = [];

  if (userGithubInfo) {
    done.push(t('appHome.home.setup.github.done', { login: userGithubInfo.user.login }));
  } else {
    fixes.push(
      row(
        t('appHome.home.setup.github.todo'),
        button(t('appHome.documentConnection.connect.button'), 'connect_personal_github', { style: 'primary' }),
      ),
    );
  }

  // The repository fix is meaningless before GitHub is connected, so it waits.
  if (userGithubInfo) {
    if (repoInfo) {
      done.push(t('appHome.home.setup.repo.done', { repo: repoLabel(t, repoInfo) }));
    } else {
      fixes.push(
        row(
          t('appHome.home.setup.repo.todo'),
          button(t('appHome.documentConnection.browse.button'), 'browse_github_repositories', { style: 'primary' }),
        ),
      );
    }
  }

  if (qaChannelName) {
    done.push(t('appHome.home.setup.channel.done', { channel: qaChannelName }));
  } else {
    fixes.push(row(t('appHome.home.setup.channel.todo'), qaChannelSelect(t, undefined)));
  }

  done.push(t('appHome.home.setup.people.done', { users: choirUsers.length, managers: managers.length }));

  return {
    blocks: [row([t('appHome.home.setup.label'), ...done].join('\n')), ...fixes],
    incomplete: fixes.length > 0,
  };
};

// --- 📁 Documents ----------------------------------------------------------

const buildDocumentsTab = async (t: T, locale: Locale, workspaceId: string, userId: string): Promise<any[]> => {
  const workspaceStore = new WorkspaceStore();
  const [userGithubInfo, repoInfo, readOnlyFiles, markdownFiles, workspaceConfig, contentLanguage] = await Promise.all([
    workspaceStore.getUserGithubInfo(workspaceId, userId),
    getGithubRepo(workspaceId),
    workspaceStore.getReadOnlyFiles(workspaceId),
    workspaceStore.getCachedMarkdownFiles(workspaceId),
    workspaceStore.getWorkspaceConfig(workspaceId),
    workspaceStore.getContentLanguage(workspaceId),
  ]);

  const blocks: Block[] = [];

  if (userGithubInfo) {
    blocks.push(
      row(
        t('appHome.documents.github.connected', {
          login: `<https://github.com/${userGithubInfo.user.login}|${userGithubInfo.user.login}>`,
          date: userGithubInfo.connectedAt.toLocaleDateString(locale),
        }),
        button(t('appHome.documentConnection.disconnect.button'), 'disconnect_personal_github', {
          style: 'danger',
          ...confirm(
            t,
            t('appHome.documentConnection.disconnect.confirm.title'),
            t('appHome.documentConnection.disconnect.confirm.text'),
            t('appHome.documentConnection.disconnect.confirm.ok.button'),
          ),
        }),
      ),
    );
  } else {
    blocks.push(
      row(
        t('appHome.documents.github.notConnected'),
        button(t('appHome.documentConnection.connect.button'), 'connect_personal_github', { style: 'primary' }),
      ),
    );
  }

  // The repository row is hidden until GitHub is connected: there is nothing to
  // browse without a token.
  if (userGithubInfo) {
    blocks.push(
      repoInfo
        ? row(
            // URLs never live in the catalog: the link is assembled here and the
            // catalog only gets the finished `<url|label>` to place in a sentence.
            t('appHome.documents.repo.connected', { repoLink: `<${repoInfo.url}|${repoLabel(t, repoInfo)}>` }),
            button(t('appHome.documents.repo.change.button'), 'browse_github_repositories'),
          )
        : row(
            t('appHome.documents.repo.notConnected'),
            button(t('appHome.documentConnection.browse.button'), 'browse_github_repositories', { style: 'primary' }),
          ),
    );
  }

  blocks.push(...buildReadOnlyRow(t, readOnlyFiles, markdownFiles, workspaceConfig));

  blocks.push(buildContentLanguageRow(t, contentLanguage));

  if (repoInfo) {
    blocks.push(divider, row(t('appHome.documentConnection.indexManagement.summary')), buildIndexJobs(t));
  }

  return blocks;
};

const buildReadOnlyRow = (
  t: T,
  readOnlyFiles: string[],
  markdownFiles: Array<{ path?: string }> | null | undefined,
  workspaceConfig: { githubRepo?: unknown } | null | undefined,
): Block[] => {
  if (!markdownFiles || markdownFiles.length === 0) {
    return [
      row(
        workspaceConfig?.githubRepo
          ? t('appHome.documents.readOnly.loading')
          : t('appHome.documents.readOnly.needsRepo'),
      ),
    ];
  }

  const preview = readOnlyFiles.slice(0, READ_ONLY_PREVIEW);
  const remaining = readOnlyFiles.length - preview.length;
  const list =
    remaining > 0
      ? [...preview, t('appHome.documents.readOnly.more', { count: remaining })].join(', ')
      : preview.join(', ');

  return [
    row(
      t('appHome.documents.readOnly.summary', { count: readOnlyFiles.length, total: markdownFiles.length }),
      button(t('appHome.readOnly.manage.button'), 'manage_readonly_files'),
    ),
    context(
      readOnlyFiles.length > 0
        ? t('appHome.documents.readOnly.current', { list })
        : t('appHome.documents.readOnly.currentNone'),
    ),
  ];
};

/**
 * The three index jobs. They are long-running rather than destructive, so they
 * stay default-styled and keep the confirm dialogs they have always had.
 */
const buildIndexJobs = (t: T): Block =>
  actions([
    button(t('appHome.documentConnection.reload.button'), 'reload_from_github', {
      ...confirm(
        t,
        t('appHome.documentConnection.reload.confirm.title'),
        t('appHome.documentConnection.reload.confirm.text'),
        t('appHome.documentConnection.reload.confirm.ok.button'),
      ),
    }),
    button(t('appHome.documentConnection.normalize.button'), 'normalize_markdown_files', {
      ...confirm(
        t,
        t('appHome.documentConnection.normalize.confirm.title'),
        t('appHome.documentConnection.normalize.confirm.text'),
        t('appHome.documentConnection.normalize.confirm.ok.button'),
      ),
    }),
    button(t('appHome.documentConnection.rebuildQmd.button'), 'rebuild_qmd_index', {
      ...confirm(
        t,
        t('appHome.documentConnection.rebuildQmd.confirm.title'),
        t('appHome.documentConnection.rebuildQmd.confirm.text'),
        t('appHome.documentConnection.rebuildQmd.confirm.ok.button'),
      ),
    }),
  ]);

// --- 👥 Team ---------------------------------------------------------------

const buildTeamTab = async (t: T, client: WebClient, logger: Logger, workspaceId: string): Promise<any[]> => {
  const workspaceStore = new WorkspaceStore();
  const [managers, choirUsers, organizationNameRaw, qaChannelId, workspaceLanguage] = await Promise.all([
    getManagers(workspaceId),
    getCHOIRUsers(workspaceId),
    getOrganizationName(workspaceId),
    getQAChannel(workspaceId, client),
    workspaceStore.getWorkspaceLanguage(workspaceId),
  ]);

  let organizationName = organizationNameRaw;
  if (!organizationName) {
    const [workspaceInfo, teamInfo] = await Promise.all([client.auth.test(), client.team.info()]);
    organizationName = teamInfo.team?.name || workspaceInfo.team || t('appHome.organization.defaultName');
  }

  // Managers are plain `<@U…>` mentions: Slack renders the display name itself,
  // which is one `users.info` per manager we no longer have to spend.
  const managersText =
    managers.length > 0
      ? t('appHome.team.managers.summary', {
          count: managers.length,
          list: managers.map((id) => `<@${id}>`).join(', '),
        })
      : t('appHome.team.managers.none');

  return [
    row(managersText, button(t('appHome.choirManagement.managers.button'), 'manage_managers')),
    row(
      t('appHome.team.choirUsers.summary', { count: choirUsers.length }),
      button(t('appHome.choirManagement.choirUsers.button'), 'manage_choir_users'),
    ),
    row(await qaChannelStatus(t, client, logger, qaChannelId), qaChannelSelect(t, qaChannelId)),
    row(
      t('appHome.team.organization.summary', { name: organizationName }),
      button(t('appHome.organization.edit.button'), 'edit_organization_name'),
    ),
    buildWorkspaceLanguageRow(t, workspaceLanguage),
  ];
};

const qaChannelStatus = async (
  t: T,
  client: WebClient,
  logger: Logger,
  qaChannelId: string | null | undefined,
): Promise<string> => {
  if (!qaChannelId) return t('appHome.team.qaChannel.notConfigured');
  const name = await resolveChannelName(client, logger, qaChannelId);
  return name ? t('appHome.team.qaChannel.configured', { channel: name }) : t('appHome.team.qaChannel.notFound');
};

const qaChannelSelect = (t: T, qaChannelId: string | undefined): Block => ({
  type: 'channels_select',
  placeholder: { type: 'plain_text', text: t('appHome.choirManagement.qaChannel.placeholder'), emoji: true },
  action_id: 'select_qa_channel',
  ...(qaChannelId ? { initial_channel: qaChannelId } : {}),
});

// --- ⚙️ Advanced -----------------------------------------------------------

const buildAdvancedTab = async (t: T, workspaceId: string): Promise<any[]> => {
  const workspaceStore = new WorkspaceStore();
  const [settings, keyStatus, loggingEnabled] = await Promise.all([
    workspaceStore.getOpenAISettings(workspaceId),
    workspaceStore.getContextKeyStatus(workspaceId),
    workspaceStore.getLoggingEnabled(workspaceId),
  ]);
  const { CLASSIFICATION_MODEL } = await import('services/llm/llm-config');

  const blocks: Block[] = [
    row(
      t('appHome.advanced.openai.summary', {
        keyStatus: openAIKeyStatus(t, settings?.apiKey),
        qaModel: settings?.qaModel || t('appHome.openai.model.serverDefault'),
        documentUpdateModel: settings?.documentUpdateModel || t('appHome.openai.model.serverDefault'),
      }),
      button(t('appHome.openai.configure.button'), 'configure_openai'),
    ),
    context(t('appHome.advanced.openai.context', { classificationModel: CLASSIFICATION_MODEL })),
  ];

  if (settings?.apiKey) {
    blocks.push(
      actions([
        button(t('appHome.openai.clear.button'), 'clear_openai_settings', {
          style: 'danger',
          ...confirm(
            t,
            t('appHome.openai.clear.confirm.title'),
            t('appHome.openai.clear.confirm.text'),
            t('appHome.openai.clear.confirm.ok.button'),
          ),
        }),
      ]),
    );
  }

  blocks.push(
    divider,
    row(contextKeyStatus(t, keyStatus), button(t('appHome.contextKey.import.button'), 'import_context_key')),
  );

  if (keyStatus.configured) {
    blocks.push(
      actions([
        button(t('appHome.contextKey.backup.button'), 'backup_context_key'),
        button(t('appHome.contextKey.rotate.button'), 'rotate_context_key', { style: 'danger' }),
      ]),
    );
  }
  blocks.push(context(t('appHome.contextKey.warning')));

  blocks.push(
    divider,
    row(
      loggingEnabled ? t('appHome.advanced.logging.enabled') : t('appHome.advanced.logging.disabled'),
      button(
        loggingEnabled ? t('appHome.logging.disable.button') : t('appHome.logging.enable.button'),
        'toggle_logging',
      ),
    ),
    row(t('appHome.advanced.logs.summary')),
    actions([
      button(t('appHome.logs.today.button'), 'download_today_logs'),
      button(t('appHome.logs.all.button'), 'download_all_logs'),
    ]),
  );

  return blocks;
};

const openAIKeyStatus = (t: T, apiKey: string | undefined): string => {
  if (apiKey) {
    const masked = apiKey.length <= 8 ? '••••' : `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
    return t('appHome.openai.key.workspaceSet', { masked });
  }
  return process.env.OPENAI_API_KEY ? t('appHome.openai.key.serverDefault') : t('appHome.openai.key.notConfigured');
};

const contextKeyStatus = (t: T, status: { configured: boolean; createdAt?: string; rotatedAt?: string }): string => {
  if (!status.configured) return t('appHome.advanced.contextKey.notGenerated');

  // These are ISO timestamps, not `Date`s, so the date part is sliced off rather
  // than run through the reader's locale formatter.
  const details = [
    status.createdAt ? t('appHome.contextKey.status.created', { date: status.createdAt.slice(0, 10) }) : null,
    status.rotatedAt ? t('appHome.contextKey.status.rotated', { date: status.rotatedAt.slice(0, 10) }) : null,
  ].filter(Boolean);

  return t('appHome.advanced.contextKey.configured', {
    details: details.length > 0 ? ` · ${details.join(' · ')}` : '',
  });
};

// --- Language rows ---------------------------------------------------------

/** A Block Kit option; `value` is what the handler receives, `text` what a human reads. */
const languageOption = (label: string, value: string) => ({
  text: { type: 'plain_text', text: label, emoji: true },
  value,
});

const languageSelect = (actionId: string, placeholder: string, options: any[], selected: string): Block => ({
  type: 'static_select',
  action_id: actionId,
  placeholder: { type: 'plain_text', text: placeholder, emoji: true },
  options,
  initial_option: options.find((option) => option.value === selected) ?? options[0],
});

const workspaceLanguageOptions = (t: T) => [
  languageOption(t('appHome.language.option.english'), 'en'),
  languageOption(t('appHome.language.option.korean'), 'ko'),
];

/**
 * The picker every CHOIR user gets, whatever their role: which language CHOIR
 * speaks *to them*. `null` (no stored preference) shows as Automatic, which is
 * the truth — CHOIR then follows their Slack language, then the workspace
 * default.
 *
 * Exported, like the two rows below, so a test can render the row without
 * standing up the whole home view.
 */
export const buildMyLanguageRow = (t: T, userLanguage: Locale | null): any =>
  row(
    t('appHome.language.mine.label'),
    languageSelect(
      'set_my_language',
      t('appHome.language.mine.placeholder'),
      [languageOption(t('appHome.language.option.auto'), 'auto'), ...workspaceLanguageOptions(t)],
      userLanguage ?? 'auto',
    ),
  );

/** Team tab: the workspace default for CHOIR's own strings. */
export const buildWorkspaceLanguageRow = (t: T, workspaceLanguage: Locale): any =>
  row(
    `${t('appHome.language.workspace.label')}\n${t('appHome.language.workspace.context')}`,
    languageSelect(
      'set_workspace_language',
      t('appHome.language.workspace.placeholder'),
      workspaceLanguageOptions(t),
      workspaceLanguage,
    ),
  );

/**
 * Documents tab: what language CHOIR *writes documents* in. A separate setting
 * from the one above because a team can want CHOIR speaking Korean in Slack
 * while the repository stays English.
 */
export const buildContentLanguageRow = (t: T, contentLanguage: 'follow-conversation' | Locale): any =>
  row(
    `${t('appHome.language.content.label')}\n${t('appHome.language.content.context')}`,
    languageSelect(
      'set_content_language',
      t('appHome.language.content.placeholder'),
      [
        languageOption(t('appHome.language.option.followConversation'), 'follow-conversation'),
        ...workspaceLanguageOptions(t),
      ],
      contentLanguage,
    ),
  );

// --- Shared helpers --------------------------------------------------------

const repoLabel = (t: T, repoInfo: { owner: string; repo: string; path?: string }): string =>
  repoInfo.path
    ? t('appHome.documentConnection.repo.labelWithPath', {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        path: repoInfo.path,
      })
    : t('appHome.documentConnection.repo.label', { owner: repoInfo.owner, repo: repoInfo.repo });

/** The channel's name, or `null` when it is unset or CHOIR can no longer see it. */
const resolveChannelName = async (
  client: WebClient,
  logger: Logger,
  channelId: string | null | undefined,
): Promise<string | null> => {
  if (!channelId) return null;
  try {
    const channelInfo = await client.conversations.info({ channel: channelId });
    return channelInfo.channel?.name || null;
  } catch (error) {
    logger.warn(`Could not get Q&A channel name for ${channelId}:`, error);
    return null;
  }
};

/**
 * "Team Insights" link to the web awareness dashboard. Shown to CHOIR users
 * (registered members, incl. managers) when a public web base URL is set; the
 * dashboard page itself re-gates on CHOIR-user status.
 */
const teamInsightsUrl = (workspaceId: string, isChoirUser: boolean): string | null => {
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  if (!isChoirUser || !baseUrl) return null;
  return `${baseUrl}/docs/${encodeURIComponent(workspaceId)}/dashboard`;
};

/**
 * Deep link to the Messages tab. In OAuth mode SLACK_APP_ID must be set; the
 * legacy SLACK_APP_TOKEN fallback only works for single-workspace dev/socket mode.
 */
const startChatUrl = (logger: Logger, authTest: { team_id?: string; user_id?: string }): string => {
  const appId = resolveAppIdFromEnv();
  if (!appId) {
    logger.warn('SLACK_APP_ID is not configured; App Home start-chat button will fall back to bot DM deep link.');
    return `slack://user?team=${authTest.team_id}&id=${authTest.user_id}&tab=messages`;
  }
  return `slack://app?team=${authTest.team_id}&id=${appId}&tab=messages`;
};

// SLACK_APP_TOKEN encodes the app id as the third dash-separated segment;
// only useful as a single-workspace fallback when SLACK_APP_ID is missing.
function resolveAppIdFromEnv(): string | undefined {
  if (process.env.SLACK_APP_ID) {
    return process.env.SLACK_APP_ID;
  }
  const token = process.env.SLACK_APP_TOKEN;
  if (!token) {
    return undefined;
  }
  const parts = token.split('-');
  if (parts.length >= 3 && parts[0] === 'xapp') {
    return parts[2];
  }
  return undefined;
}
