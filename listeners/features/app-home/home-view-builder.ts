import type { Logger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  getCHOIRUsers,
  getGithubRepo,
  getManagers,
  getOrganizationDescription,
  getOrganizationName,
  getQAChannel,
  isManager,
  isWorkspaceOwner,
} from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';

export const buildHomeView = async (client: WebClient, logger: Logger, workspaceId: string, userId: string) => {
  const isUserManager = await isManager(workspaceId, userId);
  const isOwner = await isWorkspaceOwner(userId, client);
  const managers = await getManagers(workspaceId);
  const choirUsers = await getCHOIRUsers(workspaceId);

  const workspaceStore = new WorkspaceStore();
  const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);

  const organizationDescription = (await getOrganizationDescription(workspaceId)) || 'No description set.';

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

  const organizationDescriptionBlocks = buildOrganizationDescriptionBlocks(
    isUserManager,
    isOwner,
    organizationName,
    organizationDescription,
  );

  const logDownloadBlocks = buildLogDownloadBlocks(isUserManager, isOwner);

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
    {
      type: 'divider',
    },
  ];

  return [
    ...homeBlocks,
    ...documentConnectionBlocks,
    ...choirManagementBlocks,
    ...becomeManagerBlocks,
    ...organizationDescriptionBlocks,
    ...logDownloadBlocks,
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
      type: 'header',
      text: {
        type: 'plain_text',
        text: '👑 Request Manager Access',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Enter the manager password to gain access to advanced features and settings.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Become Manager',
            emoji: true,
          },
          style: 'primary',
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

  // Check if environment token is available
  const hasEnvToken = !!process.env.GITHUB_TOKEN;

  if (hasEnvToken) {
    // Show environment token status instead of personal GitHub connection
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*GitHub Access:* ✅ Environment token configured\n\nUsing GitHub Personal Access Token from environment variables.',
      },
    });
  } else if (userGithubInfo) {
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
          text: '*Personal GitHub Access:* ❌ Not connected\n\nConnect your personal GitHub account to access your private repositories.',
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

  if ((isUserManager || isOwner) && (userGithubInfo || hasEnvToken)) {
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

  if ((isUserManager || isOwner) && (userGithubInfo || hasEnvToken)) {
    const savedRepoInfo = await getGithubRepo(workspaceId);
    if (savedRepoInfo) {
      const vectorStore = VectorStoreService.getInstance();
      const diagnosis = vectorStore.diagnoseVectorStore();

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
        elements: [
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
        ],
      },
    );
    }
  }

  blocks.push({
    type: 'divider',
  });

  return blocks;
};

const buildOrganizationDescriptionBlocks = (
  isUserManager: boolean,
  isOwner: boolean,
  organizationName: string,
  organizationDescription: string,
) => {
  if (!isUserManager && !isOwner) {
    return [];
  }

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🏢 Organization Description',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Organization Name:* ${organizationName}\n*Description:* ${organizationDescription}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Edit Name and Description',
            emoji: true,
          },
          style: 'primary',
          action_id: 'edit_organization_info',
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
