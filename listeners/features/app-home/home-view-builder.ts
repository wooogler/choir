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

export const buildHomeView = async (
  client: WebClient,
  logger: Logger,
  workspaceId: string,
  userId: string,
): Promise<any[]> => {
  const workspaceStore = new WorkspaceStore();
  const [isUserManager, isOwner, managers, choirUsers, userGithubInfo, organizationNameRaw] = await Promise.all([
    isManager(workspaceId, userId),
    isWorkspaceOwner(userId, client),
    getManagers(workspaceId),
    getCHOIRUsers(workspaceId),
    workspaceStore.getUserGithubInfo(workspaceId, userId),
    getOrganizationName(workspaceId),
  ]);

  // The network-resolving variant is deliberate here: rendering Home already
  // costs a `users.info`, and resolving now warms the locale cache for every
  // cheap (`...Cached`) lookup this person's next interactions will do. It runs
  // before any block is built because every builder below reads from `t`.
  const t = createT(await resolveLocaleForUser(workspaceId, userId, client));

  let organizationName = organizationNameRaw;
  if (!organizationName) {
    const workspaceInfo = await client.auth.test();
    const teamInfo = await client.team.info();
    organizationName = teamInfo.team?.name || workspaceInfo.team || t('appHome.organization.defaultName');
  }

  const choirManagementBlocks = await buildChoirManagementBlocks(
    t,
    client,
    logger,
    workspaceId,
    isUserManager,
    isOwner,
    managers,
    choirUsers,
  );

  const becomeManagerBlocks = buildBecomeManagerBlocks(t, isUserManager, isOwner);

  const documentConnectionBlocks = await buildDocumentConnectionBlocks(
    t,
    workspaceId,
    isUserManager,
    isOwner,
    userGithubInfo,
  );

  const organizationNameBlocks = buildOrganizationNameBlocks(t, isUserManager, isOwner, organizationName);

  const logDownloadBlocks = buildLogDownloadBlocks(t, isUserManager, isOwner);

  const loggingEnabled = await workspaceStore.getLoggingEnabled(workspaceId);
  const loggingToggleBlocks = buildLoggingToggleBlocks(t, isUserManager, isOwner, loggingEnabled);

  const [userLanguage, workspaceLanguage, contentLanguage] = await Promise.all([
    workspaceStore.getUserLanguage(workspaceId, userId),
    workspaceStore.getWorkspaceLanguage(workspaceId),
    workspaceStore.getContentLanguage(workspaceId),
  ]);
  const myLanguageBlocks = buildMyLanguageBlocks(t, userLanguage);
  const languageSettingsBlocks = buildLanguageSettingsBlocks(
    t,
    isUserManager,
    isOwner,
    workspaceLanguage,
    contentLanguage,
  );

  const readOnlyFilesBlocks = await buildReadOnlyFilesBlocks(t, workspaceId, isUserManager, isOwner);

  const openAISettingsBlocks = await buildOpenAISettingsBlocks(t, workspaceId, isUserManager, isOwner);

  const contextKeyBlocks = await buildContextKeyBlocks(t, workspaceId, isUserManager, isOwner);

  // Build the deep-link URL for the Messages tab. In OAuth mode SLACK_APP_ID
  // must be set; the legacy SLACK_APP_TOKEN fallback only works for single
  // workspace dev / socket mode.
  const authTest = await client.auth.test();
  const teamId = authTest.team_id;
  const botUserId = authTest.user_id;
  const appId = resolveAppIdFromEnv();
  if (!appId) {
    logger.warn('SLACK_APP_ID is not configured; App Home start-chat button will fall back to bot DM deep link.');
  }
  const startChatUrl = appId
    ? `slack://app?team=${teamId}&id=${appId}&tab=messages`
    : `slack://user?team=${teamId}&id=${botUserId}&tab=messages`;

  const homeBlocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.welcome.greeting', { user: `<@${userId}>` }),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.welcome.intro'),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.welcome.prompt'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.welcome.startChat.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'start_chat_url',
          url: startChatUrl,
        },
      ],
    },
    { type: 'divider' },
  ];

  const insightsBlocks = buildInsightsBlocks(t, workspaceId, choirUsers.includes(userId));

  return [
    ...homeBlocks,
    ...myLanguageBlocks,
    ...insightsBlocks,
    ...documentConnectionBlocks,
    ...choirManagementBlocks,
    ...openAISettingsBlocks,
    ...contextKeyBlocks,
    ...becomeManagerBlocks,
    ...organizationNameBlocks,
    ...readOnlyFilesBlocks,
    ...languageSettingsBlocks,
    ...loggingToggleBlocks,
    ...logDownloadBlocks,
  ];
};

/**
 * "Team Insights" entry linking to the web awareness dashboard. Shown to CHOIR
 * users (registered members, incl. managers) when a public web base URL is set.
 * The dashboard page itself re-gates on CHOIR-user status.
 *
 * Exported, like the other synchronous builders below, so the blocks can be
 * rendered in a test without standing up the whole home view.
 */
export const buildInsightsBlocks = (t: T, workspaceId: string, isChoirUser: boolean): any[] => {
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  if (!isChoirUser || !baseUrl) return [];

  const dashboardUrl = `${baseUrl}/docs/${encodeURIComponent(workspaceId)}/dashboard`;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.insights.summary'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: t('appHome.insights.open.button'), emoji: true },
          action_id: 'open_dashboard_url',
          url: dashboardUrl,
        },
      ],
    },
    { type: 'divider' },
  ];
};

const buildOpenAISettingsBlocks = async (t: T, workspaceId: string, isUserManager: boolean, isOwner: boolean) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  const { WorkspaceStore } = await import('services/workspace/workspace-store');
  const { CLASSIFICATION_MODEL } = await import('services/llm/llm-config');
  const settings = await new WorkspaceStore().getOpenAISettings(workspaceId);

  const hasWorkspaceKey = !!settings?.apiKey;
  const hasEnvKey = !!process.env.OPENAI_API_KEY;
  let keyStatus: string;
  if (hasWorkspaceKey) {
    const key = settings?.apiKey ?? '';
    const masked = key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
    keyStatus = t('appHome.openai.key.workspaceSet', { masked });
  } else if (hasEnvKey) {
    keyStatus = t('appHome.openai.key.serverDefault');
  } else {
    keyStatus = t('appHome.openai.key.notConfigured');
  }

  const qaModelLabel = settings?.qaModel || t('appHome.openai.model.serverDefault');
  const documentUpdateModelLabel = settings?.documentUpdateModel || t('appHome.openai.model.serverDefault');

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: t('appHome.openai.header'), emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.openai.summary', {
          keyStatus,
          qaModel: qaModelLabel,
          documentUpdateModel: documentUpdateModelLabel,
          classificationModel: CLASSIFICATION_MODEL,
        }),
      },
    },
  ];

  const actionElements: any[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: t('appHome.openai.configure.button'), emoji: true },
      style: 'primary',
      action_id: 'configure_openai',
    },
  ];

  if (hasWorkspaceKey) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: t('appHome.openai.clear.button'), emoji: true },
      style: 'danger',
      action_id: 'clear_openai_settings',
      confirm: {
        title: { type: 'plain_text', text: t('appHome.openai.clear.confirm.title') },
        text: {
          type: 'plain_text',
          text: t('appHome.openai.clear.confirm.text'),
        },
        confirm: { type: 'plain_text', text: t('appHome.openai.clear.confirm.ok.button') },
        deny: { type: 'plain_text', text: t('common.button.cancel') },
      },
    });
  }

  blocks.push(
    {
      type: 'actions',
      elements: actionElements,
    },
    { type: 'divider' },
  );

  return blocks;
};

const buildContextKeyBlocks = async (t: T, workspaceId: string, isUserManager: boolean, isOwner: boolean) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  const { WorkspaceStore } = await import('services/workspace/workspace-store');
  const status = await new WorkspaceStore().getContextKeyStatus(workspaceId);

  const asDate = (iso?: string) => (iso ? iso.slice(0, 10) : null);
  let statusText: string;
  if (status.configured) {
    const created = asDate(status.createdAt);
    const rotated = asDate(status.rotatedAt);
    statusText = [
      t('appHome.contextKey.status.configured'),
      created ? t('appHome.contextKey.status.created', { date: created }) : null,
      rotated ? t('appHome.contextKey.status.rotated', { date: rotated }) : null,
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    statusText = t('appHome.contextKey.status.notGenerated');
  }

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: t('appHome.contextKey.header'), emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.contextKey.summary', { status: statusText }),
      },
    },
  ];

  const actionElements: any[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: t('appHome.contextKey.import.button'), emoji: true },
      action_id: 'import_context_key',
    },
  ];

  if (status.configured) {
    actionElements.unshift(
      {
        type: 'button',
        text: { type: 'plain_text', text: t('appHome.contextKey.backup.button'), emoji: true },
        action_id: 'backup_context_key',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: t('appHome.contextKey.rotate.button'), emoji: true },
        style: 'danger',
        action_id: 'rotate_context_key',
      },
    );
  }

  blocks.push(
    {
      type: 'actions',
      elements: actionElements,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: t('appHome.contextKey.warning'),
        },
      ],
    },
    { type: 'divider' },
  );

  return blocks;
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

const buildChoirManagementBlocks = async (
  t: T,
  client: WebClient,
  logger: Logger,
  workspaceId: string,
  isUserManager: boolean,
  isOwner: boolean,
  managers: string[],
  choirUsers: string[],
) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  const blocks = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: t('appHome.choirManagement.header'),
      emoji: true,
    },
  });

  let managersListText = '';
  if (managers.length > 0) {
    const managerNames = [];
    for (const managerId of managers) {
      try {
        const userInfo = await client.users.info({ user: managerId });
        const name =
          userInfo.user?.real_name || userInfo.user?.name || t('appHome.choirManagement.managers.unknownName');
        managerNames.push(t('appHome.choirManagement.managers.entry', { user: `<@${managerId}>`, name }));
      } catch (error) {
        logger.error(`Failed to get user info for manager ${managerId}:`, error);
        managerNames.push(`<@${managerId}>`);
      }
    }
    managersListText = t('appHome.choirManagement.managers.list', {
      list: managerNames.map((name) => `• ${name}`).join('\n'),
    });
  } else {
    managersListText = t('appHome.choirManagement.managers.none');
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.choirManagement.managers.summary', { managers: managersListText }),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.choirManagement.managers.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'manage_managers',
        },
      ],
    },
  );

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.choirManagement.choirUsers.summary', { count: choirUsers.length }),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.choirManagement.choirUsers.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'manage_choir_users',
        },
      ],
    },
  );

  const qaChannelId = await getQAChannel(workspaceId, client);
  let qaChannelName = '';
  let channelStatus = t('appHome.choirManagement.qaChannel.status.notConfigured');

  if (qaChannelId) {
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      qaChannelName = channelInfo.channel?.name || t('appHome.choirManagement.qaChannel.unknownName');
      channelStatus = t('appHome.choirManagement.qaChannel.status.configured');
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
      qaChannelName = t('appHome.choirManagement.qaChannel.unknownName');
      channelStatus = t('appHome.choirManagement.qaChannel.status.notFound');
    }
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: t('appHome.choirManagement.qaChannel.summary', {
        status: channelStatus,
        current: qaChannelId
          ? t('appHome.choirManagement.qaChannel.current', { channel: qaChannelName })
          : t('appHome.choirManagement.qaChannel.currentNone'),
      }),
    },
  });

  if (!qaChannelId) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.choirManagement.qaChannel.alert'),
      },
    });
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.choirManagement.qaChannel.instructions'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'channels_select',
          placeholder: {
            type: 'plain_text',
            text: t('appHome.choirManagement.qaChannel.placeholder'),
            emoji: true,
          },
          action_id: 'select_qa_channel',
          ...(qaChannelId ? { initial_channel: qaChannelId } : {}),
        },
      ],
    },
  );

  blocks.push({
    type: 'divider',
  });

  return blocks;
};

export const buildBecomeManagerBlocks = (t: T, isUserManager: boolean, isOwner: boolean) => {
  if (isUserManager || isOwner) {
    return [];
  }

  return [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: t('appHome.becomeManager.hint'),
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.becomeManager.button'),
            emoji: true,
          },
          action_id: 'request_manager_permission',
        },
      ],
    },
    {
      type: 'divider',
    },
  ];
};

const buildDocumentConnectionBlocks = async (
  t: T,
  workspaceId: string,
  isUserManager: boolean,
  isOwner: boolean,
  userGithubInfo: any,
) => {
  // Only show Document Connection section for managers and owners
  if (!isUserManager && !isOwner) {
    return [];
  }

  const blocks = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: t('appHome.documentConnection.header'),
      emoji: true,
    },
  });

  if (userGithubInfo) {
    const login = userGithubInfo.user.login;
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // URLs never live in the catalog: the link is assembled here and the
          // catalog only gets the finished `<url|label>` to place in a sentence.
          text: t('appHome.documentConnection.personal.connected', {
            profileLink: `<https://github.com/${login}|${login}>`,
            date: userGithubInfo.connectedAt.toLocaleDateString(),
          }),
        },
        accessory: {
          type: 'image',
          image_url: userGithubInfo.user.avatar_url,
          alt_text: t('appHome.documentConnection.personal.avatarAlt'),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: t('appHome.documentConnection.disconnect.button'),
              emoji: true,
            },
            style: 'danger',
            action_id: 'disconnect_personal_github',
            confirm: {
              title: {
                type: 'plain_text',
                text: t('appHome.documentConnection.disconnect.confirm.title'),
              },
              text: {
                type: 'plain_text',
                text: t('appHome.documentConnection.disconnect.confirm.text'),
              },
              confirm: {
                type: 'plain_text',
                text: t('appHome.documentConnection.disconnect.confirm.ok.button'),
              },
              deny: {
                type: 'plain_text',
                text: t('common.button.cancel'),
              },
            },
          },
        ],
      },
    );
  } else {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('appHome.documentConnection.personal.notConnected'),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: t('appHome.documentConnection.connect.button'),
              emoji: true,
            },
            style: 'primary',
            action_id: 'connect_personal_github',
          },
        ],
      },
    );
  }

  if ((isUserManager || isOwner) && userGithubInfo) {
    const savedRepoInfo = await getGithubRepo(workspaceId);
    if (savedRepoInfo) {
      const repoLabel = savedRepoInfo.path
        ? t('appHome.documentConnection.repo.labelWithPath', {
            owner: savedRepoInfo.owner,
            repo: savedRepoInfo.repo,
            path: savedRepoInfo.path,
          })
        : t('appHome.documentConnection.repo.label', { owner: savedRepoInfo.owner, repo: savedRepoInfo.repo });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('appHome.documentConnection.repo.connected', {
            repoLink: `<${savedRepoInfo.url}|${repoLabel}>`,
          }),
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('appHome.documentConnection.repo.notConnected'),
        },
      });
    }

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.documentConnection.browse.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'browse_github_repositories',
        },
      ],
    });

    if (savedRepoInfo) {
      const managementButtons: Array<Record<string, unknown>> = [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.documentConnection.normalize.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'normalize_markdown_files',
          confirm: {
            title: {
              type: 'plain_text',
              text: t('appHome.documentConnection.normalize.confirm.title'),
            },
            text: {
              type: 'plain_text',
              text: t('appHome.documentConnection.normalize.confirm.text'),
            },
            confirm: {
              type: 'plain_text',
              text: t('appHome.documentConnection.normalize.confirm.ok.button'),
            },
            deny: {
              type: 'plain_text',
              text: t('common.button.cancel'),
            },
          },
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.documentConnection.reload.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'reload_from_github',
          confirm: {
            title: {
              type: 'plain_text',
              text: t('appHome.documentConnection.reload.confirm.title'),
            },
            text: {
              type: 'plain_text',
              text: t('appHome.documentConnection.reload.confirm.text'),
            },
            confirm: {
              type: 'plain_text',
              text: t('appHome.documentConnection.reload.confirm.ok.button'),
            },
            deny: {
              type: 'plain_text',
              text: t('common.button.cancel'),
            },
          },
        },
      ];

      managementButtons.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: t('appHome.documentConnection.rebuildQmd.button'),
          emoji: true,
        },
        action_id: 'rebuild_qmd_index',
        confirm: {
          title: {
            type: 'plain_text',
            text: t('appHome.documentConnection.rebuildQmd.confirm.title'),
          },
          text: {
            type: 'plain_text',
            text: t('appHome.documentConnection.rebuildQmd.confirm.text'),
          },
          confirm: {
            type: 'plain_text',
            text: t('appHome.documentConnection.rebuildQmd.confirm.ok.button'),
          },
          deny: {
            type: 'plain_text',
            text: t('common.button.cancel'),
          },
        },
      });

      blocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('appHome.documentConnection.indexManagement.summary'),
          },
        },
        {
          type: 'actions',
          elements: managementButtons as any,
        },
      );
    }
  }

  blocks.push({
    type: 'divider',
  });

  return blocks;
};

export const buildOrganizationNameBlocks = (
  t: T,
  isUserManager: boolean,
  isOwner: boolean,
  organizationName: string,
) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: t('appHome.organization.header'),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.organization.summary', { name: organizationName }),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.organization.edit.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'edit_organization_name',
        },
      ],
    },
    {
      type: 'divider',
    },
  ];
};

export const buildLogDownloadBlocks = (t: T, isUserManager: boolean, isOwner: boolean) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: t('appHome.logs.header'),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.logs.summary'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.logs.today.button'),
            emoji: true,
          },
          action_id: 'download_today_logs',
          style: 'primary',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.logs.all.button'),
            emoji: true,
          },
          action_id: 'download_all_logs',
          style: 'primary',
        },
      ],
    },
    {
      type: 'divider',
    },
  ];
};

/** A Block Kit option; `value` is what the handler receives, `text` what a human reads. */
const languageOption = (label: string, value: string) => ({
  text: { type: 'plain_text', text: label, emoji: true },
  value,
});

/**
 * The picker every CHOIR user gets, whatever their role: which language CHOIR
 * speaks *to them*. `null` (no stored preference) shows as Automatic, which is
 * the truth — CHOIR then follows their Slack language, then the workspace
 * default.
 *
 * Exported so the blocks can be tested without standing up the whole home view.
 */
export const buildMyLanguageBlocks = (t: T, userLanguage: Locale | null): any[] => {
  const options = [
    languageOption(t('appHome.language.option.auto'), 'auto'),
    languageOption(t('appHome.language.option.english'), 'en'),
    languageOption(t('appHome.language.option.korean'), 'ko'),
  ];
  const selected = userLanguage ?? 'auto';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.language.mine.label'),
      },
      accessory: {
        type: 'static_select',
        action_id: 'set_my_language',
        placeholder: {
          type: 'plain_text',
          text: t('appHome.language.mine.placeholder'),
          emoji: true,
        },
        options,
        initial_option: options.find((option) => option.value === selected) ?? options[0],
      },
    },
    { type: 'divider' },
  ];
};

/**
 * The manager-only half: the workspace default for CHOIR's own strings, and the
 * separate policy for what language CHOIR *writes documents* in. They are two
 * settings because a team can want CHOIR speaking Korean in Slack while the
 * repository stays English.
 */
export const buildLanguageSettingsBlocks = (
  t: T,
  isUserManager: boolean,
  isOwner: boolean,
  workspaceLanguage: Locale,
  contentLanguage: 'follow-conversation' | Locale,
): any[] => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  const workspaceOptions = [
    languageOption(t('appHome.language.option.english'), 'en'),
    languageOption(t('appHome.language.option.korean'), 'ko'),
  ];
  const contentOptions = [
    languageOption(t('appHome.language.option.followConversation'), 'follow-conversation'),
    ...workspaceOptions,
  ];

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🌐 ${t('appHome.language.title')}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.language.workspace.label'),
      },
      accessory: {
        type: 'static_select',
        action_id: 'set_workspace_language',
        placeholder: {
          type: 'plain_text',
          text: t('appHome.language.workspace.placeholder'),
          emoji: true,
        },
        options: workspaceOptions,
        initial_option: workspaceOptions.find((option) => option.value === workspaceLanguage) ?? workspaceOptions[0],
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: t('appHome.language.workspace.context') }],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.language.content.label'),
      },
      accessory: {
        type: 'static_select',
        action_id: 'set_content_language',
        placeholder: {
          type: 'plain_text',
          text: t('appHome.language.content.placeholder'),
          emoji: true,
        },
        options: contentOptions,
        initial_option: contentOptions.find((option) => option.value === contentLanguage) ?? contentOptions[0],
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: t('appHome.language.content.context') }],
    },
    { type: 'divider' },
  ];
};

export const buildLoggingToggleBlocks = (t: T, isUserManager: boolean, isOwner: boolean, loggingEnabled: boolean) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: t('appHome.logging.header'),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.logging.summary', {
          status: loggingEnabled ? t('appHome.logging.status.enabled') : t('appHome.logging.status.disabled'),
        }),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: loggingEnabled ? t('appHome.logging.disable.button') : t('appHome.logging.enable.button'),
            emoji: true,
          },
          action_id: 'toggle_logging',
          style: loggingEnabled ? 'danger' : 'primary',
        },
      ],
    },
    {
      type: 'divider',
    },
  ];
};

const buildReadOnlyFilesBlocks = async (t: T, workspaceId: string, isUserManager: boolean, isOwner: boolean) => {
  // Only show this section for managers and owners
  if (!isUserManager && !isOwner) {
    return [];
  }

  const workspaceStore = new WorkspaceStore();
  const readOnlyFiles = await workspaceStore.getReadOnlyFiles(workspaceId);
  const markdownFiles = await workspaceStore.getCachedMarkdownFiles(workspaceId);

  // 캐시가 없는 경우, GitHub 연결 안내와 함께 섹션 표시
  if (!markdownFiles || markdownFiles.length === 0) {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);

    // GitHub 레포지토리가 연결되어 있지 않은 경우
    if (!config?.githubRepo) {
      return [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: t('appHome.readOnly.header'),
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('appHome.readOnly.introNeedsRepo'),
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('appHome.readOnly.repoMissing'),
          },
        },
        {
          type: 'divider',
        },
      ];
    }

    // GitHub는 연결되어 있지만 파일이 캐시되지 않은 경우
    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: t('appHome.readOnly.header'),
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('appHome.readOnly.intro'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('appHome.readOnly.loading'),
        },
      },
      {
        type: 'divider',
      },
    ];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: t('appHome.readOnly.header'),
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('appHome.readOnly.summary', { count: readOnlyFiles.length, total: markdownFiles.length }),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          readOnlyFiles.length > 0
            ? t('appHome.readOnly.current', { list: readOnlyFiles.map((file) => `• ${file}`).join('\n') })
            : t('appHome.readOnly.currentNone'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: t('appHome.readOnly.manage.button'),
            emoji: true,
          },
          style: 'primary',
          action_id: 'manage_readonly_files',
        },
      ],
    },
    {
      type: 'divider',
    },
  ];
};
