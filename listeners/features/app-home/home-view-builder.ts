import type { Logger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { VectorStoreService } from 'services/file-registry/main-service';
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

export const buildHomeView = async (client: WebClient, logger: Logger, workspaceId: string, userId: string) => {
  const isUserManager = await isManager(workspaceId, userId);
  const isOwner = await isWorkspaceOwner(userId, client);
  const managers = await getManagers(workspaceId);
  const choirUsers = await getCHOIRUsers(workspaceId);

  const workspaceStore = new WorkspaceStore();
  const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);

  let organizationName = await getOrganizationName(workspaceId);
  if (!organizationName) {
    const workspaceInfo = await client.auth.test();
    const teamInfo = await client.team.info();
    organizationName = teamInfo.team?.name || workspaceInfo.team || 'Our Organization';
  }

  const choirManagementBlocks = await buildChoirManagementBlocks(
    client,
    logger,
    workspaceId,
    isUserManager,
    isOwner,
    managers,
    choirUsers,
  );

  const becomeManagerBlocks = buildBecomeManagerBlocks(isUserManager, isOwner);

  const documentConnectionBlocks = await buildDocumentConnectionBlocks(
    client,
    logger,
    workspaceId,
    isUserManager,
    isOwner,
    userGithubInfo,
  );

  const organizationNameBlocks = buildOrganizationNameBlocks(isUserManager, isOwner, organizationName);

  const logDownloadBlocks = buildLogDownloadBlocks(isUserManager, isOwner);

  const loggingEnabled = await workspaceStore.getLoggingEnabled(workspaceId);
  const loggingToggleBlocks = buildLoggingToggleBlocks(isUserManager, isOwner, loggingEnabled);

  const readOnlyFilesBlocks = await buildReadOnlyFilesBlocks(client, logger, workspaceId, isUserManager, isOwner);

  const homeBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Welcome, <@${userId}> :house:*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'CHOIR is a tool that automatically updates documents based on Slack conversations.',
      },
    },
  ];

  // 모든 사용자에게 Messages 탭으로 이동할 수 있는 버튼 제공
  // Get team and app info for deep link
  const authTest = await client.auth.test();
  const teamId = authTest.team_id;
  const botUserId = authTest.user_id;

  // Extract app ID from SLACK_APP_TOKEN (format: xapp-1-{APP_ID}-...)
  let appId = process.env.SLACK_APP_ID;
  if (!appId && process.env.SLACK_APP_TOKEN) {
    const tokenParts = process.env.SLACK_APP_TOKEN.split('-');
    if (tokenParts.length >= 3 && tokenParts[0] === 'xapp') {
      appId = tokenParts[2]; // App ID is the third part
    }
  }

  logger.info('[DEBUG] App Home - Deep link info:', {
    teamId,
    botUserId,
    appId: appId || 'NOT_FOUND',
    hasAppToken: !!process.env.SLACK_APP_TOKEN,
  });

  homeBlocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '💬 *Ready to get started?* Click the button below to chat with CHOIR!',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '💬 Start Chatting with CHOIR',
            emoji: true,
          },
          style: 'primary',
          action_id: 'start_chat_url',
          // Use App Home deep link format for apps with App Home
          url: appId
            ? `slack://app?team=${teamId}&id=${appId}&tab=messages`
            : `slack://user?team=${teamId}&id=${botUserId}&tab=messages`,
        },
      ],
    } as any,
  );

  homeBlocks.push({
    type: 'divider',
  } as any);

  return [
    ...homeBlocks,
    ...documentConnectionBlocks,
    ...choirManagementBlocks,
    ...becomeManagerBlocks,
    ...organizationNameBlocks,
    ...readOnlyFilesBlocks,
    ...loggingToggleBlocks,
  ];
};

const buildChoirManagementBlocks = async (
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
      text: '⚙️ CHOIR Management',
      emoji: true,
    },
  });

  let managersListText = '';
  if (managers.length > 0) {
    const managerNames = [];
    for (const managerId of managers) {
      try {
        const userInfo = await client.users.info({ user: managerId });
        const name = userInfo.user?.real_name || userInfo.user?.name || 'Unknown User';
        managerNames.push(`<@${managerId}> (${name})`);
      } catch (error) {
        logger.error(`Failed to get user info for manager ${managerId}:`, error);
        managerNames.push(`<@${managerId}>`);
      }
    }
    managersListText = `*Current Managers:*\n${managerNames.map((name) => `• ${name}`).join('\n')}`;
  } else {
    managersListText = '*Current Managers:* None assigned';
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${managersListText}\n\nManagers can access advanced features and grant permissions to other users.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Manage Managers',
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
        text: `*CHOIR Users:* ${choirUsers.length} registered\nCHOIR users are authorized to use CHOIR features and participate in the research study.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Manage CHOIR Users',
            emoji: true,
          },
          style: 'primary',
          action_id: 'manage_choir_users',
        },
      ],
    },
  );

  const qaChannelId = await getQAChannel(workspaceId, client);
  let qaChannelName = 'No channel selected';
  let channelStatus = '❌ Not configured';

  if (qaChannelId) {
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      qaChannelName = channelInfo.channel?.name || 'Unknown channel';
      channelStatus = '✅ Configured';
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
      qaChannelName = 'Unknown channel';
      channelStatus = '⚠️ Channel not found';
    }
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Q&A Channel:* ${channelStatus}\n${qaChannelId ? `Current Channel: #${qaChannelName}` : 'Current Channel: None'}`,
    },
  });

  if (!qaChannelId) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "⚠️ *Alert:* No Q&A channel is configured. Users won't be able to forward questions to a channel.",
      },
    });
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Select a channel where CHOIR will forward questions when users click 'Ask to Channel'.",
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'channels_select',
          placeholder: {
            type: 'plain_text',
            text: 'Select Channel',
            emoji: true,
          },
          action_id: 'select_qa_channel',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Set Q&A Channel',
            emoji: true,
          },
          style: 'primary',
          action_id: 'set_qa_channel',
        },
      ],
    },
  );

  blocks.push({
    type: 'divider',
  });

  return blocks;
};

const buildBecomeManagerBlocks = (isUserManager: boolean, isOwner: boolean) => {
  if (isUserManager || isOwner) {
    return [];
  }

  return [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '🔒 _Need access to advanced features? Contact your workspace administrator._',
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
            text: 'Manager Access',
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
  client: WebClient,
  logger: Logger,
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
      text: '📁 Document Connection',
      emoji: true,
    },
  });

  if (userGithubInfo) {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Personal GitHub Access:* ✅ Connected\n*GitHub Username:* <https://github.com/${userGithubInfo.user.login}|${userGithubInfo.user.login}>\n*Connected:* ${userGithubInfo.connectedAt.toLocaleDateString()}`,
        },
        accessory: {
          type: 'image',
          image_url: userGithubInfo.user.avatar_url,
          alt_text: 'GitHub Avatar',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Disconnect GitHub',
              emoji: true,
            },
            style: 'danger',
            action_id: 'disconnect_personal_github',
            confirm: {
              title: {
                type: 'plain_text',
                text: 'Disconnect GitHub',
              },
              text: {
                type: 'plain_text',
                text: 'Are you sure you want to disconnect your personal GitHub account?',
              },
              confirm: {
                type: 'plain_text',
                text: 'Disconnect',
              },
              deny: {
                type: 'plain_text',
                text: 'Cancel',
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
          text: '*Personal GitHub Access:* ❌ Not connected\n\nConnect your GitHub account to access public repositories you can write to.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Connect GitHub Account',
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
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Repository Connection:* ✅ Connected\n<${savedRepoInfo.url}|${savedRepoInfo.owner}/${savedRepoInfo.repo}${
            savedRepoInfo.path ? ` (Path: ${savedRepoInfo.path})` : ''
          }>`,
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Repository Connection:* ❌ No repository connected',
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
            text: 'Browse My Repositories',
            emoji: true,
          },
          style: 'primary',
          action_id: 'browse_github_repositories',
        },
      ],
    });
  }

  if ((isUserManager || isOwner) && userGithubInfo) {
    const savedRepoInfo = await getGithubRepo(workspaceId);
    if (savedRepoInfo) {
      const vectorStore = VectorStoreService.getInstance();
      const diagnosis = vectorStore.diagnoseVectorStore(workspaceId);
      const managementButtons: Array<Record<string, unknown>> = [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Normalize Markdown',
            emoji: true,
          },
          style: 'primary',
          action_id: 'normalize_markdown_files',
          confirm: {
            title: {
              type: 'plain_text',
              text: 'Normalize Markdown Files',
            },
            text: {
              type: 'plain_text',
              text: 'This will convert all markdown files to tree format and back to markdown, standardizing the formatting. This may change newlines, list styles, etc.',
            },
            confirm: {
              type: 'plain_text',
              text: 'Normalize',
            },
            deny: {
              type: 'plain_text',
              text: 'Cancel',
            },
          },
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Reload from GitHub',
            emoji: true,
          },
          style: 'primary',
          action_id: 'reload_from_github',
          confirm: {
            title: {
              type: 'plain_text',
              text: 'Reload from GitHub?',
            },
            text: {
              type: 'plain_text',
              text: 'This will fetch the latest files from GitHub and update the vector store. Any unsaved changes will be overwritten.',
            },
            confirm: {
              type: 'plain_text',
              text: 'Reload',
            },
            deny: {
              type: 'plain_text',
              text: 'Cancel',
            },
          },
        },
      ];

      managementButtons.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Rebuild QMD Index',
          emoji: true,
        },
        action_id: 'rebuild_qmd_index',
        confirm: {
          title: {
            type: 'plain_text',
            text: 'Rebuild QMD Index?',
          },
          text: {
            type: 'plain_text',
            text: 'This will delete the local QMD SQLite index and rebuild it from the synced markdown mirror. Use this after chunking changes or if retrieval looks stale.',
          },
          confirm: {
            type: 'plain_text',
            text: 'Rebuild',
          },
          deny: {
            type: 'plain_text',
            text: 'Cancel',
          },
        },
      });

      blocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Vector Store Status:* ${diagnosis.status === 'healthy' ? '✅ Healthy' : diagnosis.status === 'degraded' ? '⚠️ Degraded' : '❌ Error'}\n*Files:* ${diagnosis.details.documentCount}\n*Chunks:* ${diagnosis.details.vectorsCount}`,
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

const buildOrganizationNameBlocks = (isUserManager: boolean, isOwner: boolean, organizationName: string) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🏢 Organization Name',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Organization Name:* ${organizationName}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Edit Organization Name',
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

const buildLogDownloadBlocks = (isUserManager: boolean, isOwner: boolean) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '📊 Interaction Logs Download',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Download user interaction logs for analysis and research purposes.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: "Today's Logs",
            emoji: true,
          },
          action_id: 'download_today_logs',
          style: 'primary',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'All Logs',
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

const buildLoggingToggleBlocks = (isUserManager: boolean, isOwner: boolean, loggingEnabled: boolean) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🔧 Logging Settings',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*File Logging:* ${loggingEnabled ? '✅ Enabled' : '❌ Disabled'}\n\nControls whether user interactions are saved to log files for research purposes.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: loggingEnabled ? 'Disable Logging' : 'Enable Logging',
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

const buildReadOnlyFilesBlocks = async (
  client: WebClient,
  logger: Logger,
  workspaceId: string,
  isUserManager: boolean,
  isOwner: boolean,
) => {
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
            text: '🔒 Read-Only Files',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '📋 *Read-Only Files Management*\nConnect a GitHub repository to manage read-only files. Read-only files are excluded from document updates but remain searchable.',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '⚠️ *GitHub repository not connected*\nPlease connect a GitHub repository in the Document Connection section above to manage read-only files.',
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
          text: '🔒 Read-Only Files',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '📋 *Read-Only Files Management*\nRead-only files are excluded from document updates but remain searchable.',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '⏳ *Loading files...*\nMarkdown files are being loaded from GitHub. Please refresh in a moment or use the "Reload from GitHub" button in Vector Store Management.',
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
        text: '🔒 Read-Only Files',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Read-Only Files:* ${readOnlyFiles.length} of ${markdownFiles.length} files\nRead-only files are excluded from document updates but remain searchable.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          readOnlyFiles.length > 0
            ? `*Current read-only files:*\n${readOnlyFiles.map((file) => `• ${file}`).join('\n')}`
            : '*Current read-only files:* None',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Manage Read-Only Files',
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
