import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
import archiver from 'archiver';
import {
  getCHOIRUsers,
  getChannelName,
  getGithubRepo,
  getManagers,
  getOrganizationDescription,
  getOrganizationName,
  getQAChannel,
  getWorkspaceId,
  isManager,
  isWorkspaceOwner,
  promoteToManagerWithPassword,
  setCHOIRUsers,
  setOrganizationDescription,
  setOrganizationName,
  storeGithubRepo,
} from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { GithubService } from 'services/github';

const appHomeOpenedCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'app_home_opened'>) => {
  logger.info(`App home opened for user ${event.user}, tab: ${event.tab}`);

  // Ignore the `app_home_opened` event for anything but the Home tab
  if (event.tab !== 'home') return;

  try {
    // Get workspace information
    const workspaceId = await getWorkspaceId(client);

    // Check if current user is a manager
    const isUserManager = await isManager(workspaceId, event.user);

    // Check if user is workspace owner (for initial setup)
    const isOwner = await isWorkspaceOwner(event.user, client);

    // Get current manager list and CHOIR users
    const managers = await getManagers(workspaceId);
    const choirUsers = await getCHOIRUsers(workspaceId);

    // Get organization description
    const organizationDescription = (await getOrganizationDescription(workspaceId)) || 'No description set.';

    // Get organization name (default to workspace name if not set)
    let organizationName = await getOrganizationName(workspaceId);
    if (!organizationName) {
      // Use workspace name as default
      const workspaceInfo = await client.auth.test();
      const teamInfo = await client.team.info();
      organizationName = teamInfo.team?.name || workspaceInfo.team || 'Our Organization';
    }

    // Get manager usernames
    const managerBlocks = [];

    if (managers.length > 0) {
      // Manager list header
      managerBlocks.push({
        type: 'header',
        text: {
          type: 'plain_text',
          text: '✨ Current Managers',
          emoji: true,
        },
      });

      // Get user info for each manager and add to blocks
      for (const managerId of managers) {
        try {
          const userInfo = await client.users.info({ user: managerId });
          const name = userInfo.user?.real_name || userInfo.user?.name || 'Unknown User';

          const sectionBlock: any = {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `• <@${managerId}> (${name})`,
            },
          };

          // Add accessory only if user is manager
          if (isUserManager) {
            sectionBlock.accessory = {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Remove Permission',
                emoji: true,
              },
              style: 'danger',
              value: managerId,
              action_id: 'remove_manager_permission',
              confirm: {
                title: {
                  type: 'plain_text',
                  text: 'Remove Manager Permission',
                },
                text: {
                  type: 'mrkdwn',
                  text: `Do you want to remove manager permission from *<@${managerId}>*?`,
                },
                confirm: {
                  type: 'plain_text',
                  text: 'Remove',
                },
                deny: {
                  type: 'plain_text',
                  text: 'Cancel',
                },
              },
            };
          }

          managerBlocks.push(sectionBlock);
        } catch (error) {
          logger.error(`Failed to get user info for ${managerId}:`, error);
        }
      }

      managerBlocks.push({
        type: 'divider',
      });
    }

    // Vector Store Management section (only for managers)
    const vectorStoreBlocks = [];
    if (isUserManager || isOwner) {
      const vectorStore = VectorStoreService.getInstance();
      const diagnosis = vectorStore.diagnoseVectorStore();

      vectorStoreBlocks.push(
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔄 Vector Store Management',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Current Status:* ${diagnosis.status === 'healthy' ? '✅ Healthy' : diagnosis.status === 'degraded' ? '⚠️ Degraded' : '❌ Error'}\n*Documents:* ${diagnosis.details.documentCount}\n*Vectors:* ${diagnosis.details.vectorsCount}`,
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
        {
          type: 'divider',
        },
      );
    }

    // Q&A Channel configuration section
    const qaChannelBlocks = [];

    // Show Q&A channel configuration UI only for managers or workspace owners
    if (isUserManager || isOwner) {
      // Get current Q&A channel info
      const qaChannelId = await getQAChannel(workspaceId, client);
      let qaChannelName = 'No channel selected';

      if (qaChannelId) {
        try {
          const channelInfo = await client.conversations.info({ channel: qaChannelId });
          qaChannelName = channelInfo.channel?.name || 'Unknown channel';
        } catch (error) {
          logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
          qaChannelName = 'Unknown channel';
        }
      }

      qaChannelBlocks.push(
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '💬 Q&A Channel Configuration',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Current Q&A Channel:* ${qaChannelId ? `#${qaChannelName}` : qaChannelName}`,
          },
        },
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
        {
          type: 'divider',
        },
      );
    }

    // Personal GitHub Login section (for all users)
    const personalGithubBlocks = [];
    const workspaceStore = new WorkspaceStore();
    
    // Check if user has personal GitHub token
    logger.info(`Checking GitHub info for user ${event.user} in workspace ${workspaceId}`);
    const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, event.user);
    if (userGithubInfo) {
      logger.info(`Found GitHub info:`, { 
        userId: event.user,
        githubLogin: userGithubInfo.user.login, 
        githubName: userGithubInfo.user.name 
      });
    }
    
    personalGithubBlocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🔐 Personal GitHub Access',
        emoji: true,
      },
    });

    if (userGithubInfo) {
      // User is connected
      personalGithubBlocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Connected as:* ${userGithubInfo.user.name || userGithubInfo.user.login}\n*GitHub Username:* @${userGithubInfo.user.login}\n*Connected:* ${userGithubInfo.connectedAt.toLocaleDateString()}`,
          },
          accessory: {
            type: 'image',
            image_url: userGithubInfo.user.avatar_url,
            alt_text: 'GitHub Avatar',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'With your personal GitHub connection, you can access your private repositories and organizations.',
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
      // User is not connected
      personalGithubBlocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Connect your personal GitHub account to access your private repositories and organizations that you have permission to view.',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🔒 *Privacy & Security*\n• Your GitHub token is stored securely and only used for repository access\n• CHOIR will only access repositories you explicitly connect\n• You can disconnect at any time',
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

    personalGithubBlocks.push({
      type: 'divider',
    });

    // GitHub Repository Connection section (right after Personal GitHub Access)
    const githubRepoBlocks = [];
    
    // Show GitHub repository connection UI for managers or owners who have connected their GitHub
    if ((isUserManager || isOwner) && userGithubInfo) {
      githubRepoBlocks.push({
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🔗 Repository Connection',
          emoji: true,
        },
      });

      // Show current connection status
      const savedRepoInfo = await getGithubRepo(workspaceId);
      if (savedRepoInfo) {
        githubRepoBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Currently Connected Repository*\n<${savedRepoInfo.url}|${savedRepoInfo.owner}/${savedRepoInfo.repo}${
              savedRepoInfo.path ? ` (Path: ${savedRepoInfo.path})` : ''
            }>`,
          },
        });
      } else {
        githubRepoBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*No repository connected*\n\nSelect a repository from your GitHub account to start using CHOIR.',
          },
        });
      }

      // Repository selection
      githubRepoBlocks.push(
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '📁 *Select a repository from your GitHub account:*',
          },
        },
        {
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
        },
        {
          type: 'divider',
        },
      );
    } else if (isUserManager || isOwner) {
      // Show message for managers/owners who haven't connected GitHub yet
      githubRepoBlocks.push(
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔗 Repository Connection',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🔐 *Connect your GitHub account first to select repositories*\n\nUse the "Personal GitHub Access" section above to connect your account.',
          },
        },
        {
          type: 'divider',
        },
      );
    }

    // Default home view blocks
    const homeBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Welcome, <@${event.user}> :house:*`,
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

    // Manager permission management section
    const managerManagementBlocks = [];

    // Organization Description section
    const organizationDescriptionBlocks = [];
    if (isUserManager || isOwner) {
      organizationDescriptionBlocks.push(
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🏢 Organization Settings',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Current Organization Name:*
${organizationName}`,
          },
        },
        {
          type: 'input',
          block_id: 'organization_name_input_block',
          element: {
            type: 'plain_text_input',
            action_id: 'organization_name_input',
            initial_value: organizationName,
            placeholder: {
              type: 'plain_text',
              text: 'Enter your organization name (e.g., Smith Research Lab, AI Team, etc.)',
            },
          },
          label: {
            type: 'plain_text',
            text: 'Set Organization Name',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Save Name',
                emoji: true,
              },
              style: 'primary',
              action_id: 'set_organization_name',
            },
          ],
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Current Description:*
${organizationDescription}`,
          },
        },
        {
          type: 'input',
          block_id: 'organization_description_input_block',
          element: {
            type: 'plain_text_input',
            action_id: 'organization_description_input',
            multiline: true,
            initial_value: organizationDescription === 'No description set.' ? '' : organizationDescription,
            placeholder: {
              type: 'plain_text',
              text: 'Enter a brief description of your organization, its goals, and common knowledge.',
            },
          },
          label: {
            type: 'plain_text',
            text: 'Set Organization Description',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Save Description',
                emoji: true,
              },
              style: 'primary',
              action_id: 'set_organization_description',
            },
          ],
        },
        {
          type: 'divider',
        },
      );
    }

    // CHOIR User Management section
    const choirUserManagementBlocks = [];
    if (isUserManager || isOwner) {
      choirUserManagementBlocks.push(
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '👥 CHOIR User Management',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Current CHOIR Users:* ${choirUsers.length} registered\n\nCHOIR users are authorized to use CHOIR features and participate in the research study. Managers are automatically included as CHOIR users.`,
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
        {
          type: 'divider',
        },
      );
    }

    // Show management UI only for managers or workspace owners
    if (isUserManager || isOwner) {
      managerManagementBlocks.push(
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '👑 Manager Permission Management',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Managers can grant and revoke manager permissions for other users.',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'users_select',
              placeholder: {
                type: 'plain_text',
                text: 'Select User',
                emoji: true,
              },
              action_id: 'select_user_for_permission',
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Grant Manager Permission',
                emoji: true,
              },
              style: 'primary',
              action_id: 'add_manager_permission',
              confirm: {
                title: {
                  type: 'plain_text',
                  text: 'Grant Manager Permission',
                },
                text: {
                  type: 'mrkdwn',
                  text: 'Are you sure you want to grant manager permission to the selected user?',
                },
                confirm: {
                  type: 'plain_text',
                  text: 'Grant',
                },
                deny: {
                  type: 'plain_text',
                  text: 'Cancel',
                },
              },
            },
          ],
        },
        {
          type: 'divider',
        },
      );
    }

    // Become Manager section (only for non-managers)
    const becomeManagerBlocks = [];
    if (!isUserManager && !isOwner) {
      becomeManagerBlocks.push(
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
      );
    }

    // Log download section (only for managers)
    const logDownloadBlocks = [];
    if (isUserManager || isOwner) {
      logDownloadBlocks.push(
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
                text: 'Download Logs',
                emoji: true,
              },
              action_id: 'download_interaction_logs',
              style: 'primary',
            },
          ],
        },
        {
          type: 'divider',
        },
      );
    }

    // Combine all blocks
    const blocks = [
      ...homeBlocks,
      ...personalGithubBlocks,
      ...githubRepoBlocks,
      ...choirUserManagementBlocks,
      ...managerManagementBlocks,
      ...managerBlocks,
      ...becomeManagerBlocks,
      ...organizationDescriptionBlocks,
      ...qaChannelBlocks,
      ...vectorStoreBlocks,
      ...logDownloadBlocks,
    ];

    // Publish the view
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks,
      },
    });
  } catch (error) {
    logger.error('Error publishing home view:', error);
  }
};

const register = (app: App) => {
  app.event('app_home_opened', appHomeOpenedCallback);

  // Handler for setting organization name
  app.action('set_organization_name', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const workspaceId = await getWorkspaceId(client);
      const viewBody = body as any;
      const newName = viewBody.view.state.values.organization_name_input_block.organization_name_input.value;

      await setOrganizationName(workspaceId, newName);

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: `✅ Organization name updated to "${newName}"!`,
      });

      // Auto-refresh home screen
      setTimeout(async () => {
        try {
          const mockEvent = {
            type: 'app_home_opened' as const,
            user: body.user.id,
            tab: 'home' as const,
            event_ts: Date.now().toString(),
          };

          const handlerArgs = {
            client,
            event: mockEvent,
            logger,
            context: {},
            payload: mockEvent,
          };

          await appHomeOpenedCallback(handlerArgs as any);
          logger.info(`Home screen refreshed for user ${body.user.id} after organization name update`);
        } catch (error) {
          logger.error('Error refreshing home view after organization name update:', error);
        }
      }, 1000);
    } catch (error) {
      logger.error('Error setting organization name:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: 'Error updating organization name. Please try again.',
      });
    }
  });

  // Handler for setting organization description
  app.action('set_organization_description', async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const workspaceId = await getWorkspaceId(client);
      const viewBody = body as any;
      const newDescription =
        viewBody.view.state.values.organization_description_input_block.organization_description_input.value;

      await setOrganizationDescription(workspaceId, newDescription);

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '✅ Organization description updated successfully!',
      });

      // Auto-refresh home screen
      setTimeout(async () => {
        try {
          const mockEvent = {
            type: 'app_home_opened' as const,
            user: body.user.id,
            tab: 'home' as const,
            event_ts: Date.now().toString(),
          };

          const handlerArgs = {
            client,
            event: mockEvent,
            logger,
            context: {},
            payload: mockEvent,
          };

          await appHomeOpenedCallback(handlerArgs as any);
          logger.info(`Home screen refreshed for user ${body.user.id} after organization description update`);
        } catch (error) {
          logger.error('Error refreshing home view after organization description update:', error);
        }
      }, 1000);
    } catch (error) {
      logger.error('Error setting organization description:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: 'Error updating organization description. Please try again.',
      });
    }
  });

  // Handler for downloading interaction logs
  app.action('download_interaction_logs', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);

      // Create logs directory path
      const logsDir = path.join(process.cwd(), 'data', 'logs');

      // Check if logs directory exists
      if (!fs.existsSync(logsDir)) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No interaction logs found.',
        });
        return;
      }

      // Get all log files
      const logFiles = fs.readdirSync(logsDir).filter((file: string) => file.endsWith('.jsonl'));

      if (logFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No interaction log files found.',
        });
        return;
      }

      // Send initial message
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '📊 Preparing interaction logs for download...',
      });

      // Create a zip file with all logs
      const timestamp = new Date().toISOString().split('T')[0];
      const zipPath = path.join(process.cwd(), 'data', `interaction-logs-${workspaceId}-${Date.now()}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      // Promise to handle archive completion
      const archivePromise = new Promise<void>((resolve, reject) => {
        output.on('close', () => {
          logger.info(`Archive created: ${archive.pointer()} total bytes`);
          resolve();
        });

        archive.on('error', (err: Error) => {
          logger.error('Archive error:', err);
          reject(err);
        });

        archive.on('warning', (err: archiver.ArchiverError) => {
          if (err.code === 'ENOENT') {
            logger.warn('Archive warning:', err);
          } else {
            reject(err);
          }
        });
      });

      archive.pipe(output);

      // Add all log files to the archive
      for (const logFile of logFiles) {
        const filePath = path.join(logsDir, logFile);
        if (fs.existsSync(filePath)) {
          archive.file(filePath, { name: logFile });
        }
      }

      await archive.finalize();
      await archivePromise;

      // Upload the zip file to Slack using files.uploadV2
      try {
        const fileSize = fs.statSync(zipPath).size;
        const fileName = `interaction-logs-${timestamp}.zip`;

        // Open DM channel first to get proper channel ID
        const dmChannel = await client.conversations.open({
          users: body.user.id,
        });

        if (!dmChannel.channel?.id) {
          throw new Error('Could not open DM channel');
        }

        // Use the newer files.uploadV2 API
        await client.files.uploadV2({
          channel_id: dmChannel.channel.id,
          file: fs.createReadStream(zipPath),
          filename: fileName,
          title: 'Interaction Logs',
          initial_comment: '📊 Here are your interaction logs for analysis.',
        });

        // Clean up the temporary zip file
        fs.unlinkSync(zipPath);

        logger.info(`Interaction logs (${fileSize} bytes) downloaded by user ${body.user.id}`);

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ Successfully uploaded interaction logs (${Math.round(fileSize / 1024)}KB)`,
        });
      } catch (uploadError) {
        logger.error('Error uploading log file:', uploadError);

        // Clean up the temporary zip file
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error uploading log files. Please try again.',
        });
      }
    } catch (error) {
      logger.error('Error downloading interaction logs:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error preparing interaction logs. Please try again.',
      });
    }
  });

  // Handler for requesting manager permission (password modal)
  app.action('request_manager_permission', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      // Open modal with password input
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'manager_password_modal',
          title: {
            type: 'plain_text',
            text: 'Become Manager',
          },
          submit: {
            type: 'plain_text',
            text: 'Submit',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '🔐 Enter the manager password to gain access to advanced features.',
              },
            },
            {
              type: 'input',
              block_id: 'password_input',
              element: {
                type: 'plain_text_input',
                action_id: 'password_value',
                placeholder: {
                  type: 'plain_text',
                  text: 'Enter manager password...',
                },
                min_length: 1,
              },
              label: {
                type: 'plain_text',
                text: 'Manager Password',
              },
            },
          ],
        },
      });
    } catch (error) {
      logger.error('Error opening manager permission modal:', error);

      // Show error message to user
      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening password modal. Please try again.',
        });
      }
    }
  });

  // Handler for managing CHOIR users
  app.action('manage_choir_users', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const choirUsers = await getCHOIRUsers(workspaceId);

      // Note: multi_users_select automatically shows all workspace users

      // Open modal with multi-select for CHOIR users
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'choir_users_modal',
          title: {
            type: 'plain_text',
            text: 'Manage CHOIR Users',
          },
          submit: {
            type: 'plain_text',
            text: 'Update Users',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '👥 *Select CHOIR Users*\n\nChoose which workspace members can use CHOIR features and participate in the research study. Managers are automatically included.',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📊 *Current Status:* ${choirUsers.length} users registered`,
              },
            },
            {
              type: 'input',
              block_id: 'choir_users_select_block',
              element: {
                type: 'multi_users_select',
                action_id: 'choir_users_select',
                initial_users: choirUsers,
                placeholder: {
                  type: 'plain_text',
                  text: 'Select users to include in CHOIR...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'CHOIR Users',
              },
              hint: {
                type: 'plain_text',
                text: 'Selected users will be able to use CHOIR features. Managers are automatically included.',
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: "🔒 *Privacy Note:* Only selected users' messages will be included in CHOIR's conversation history and research data.",
                },
              ],
            },
          ],
        },
      });
    } catch (error) {
      logger.error('Error opening CHOIR users management modal:', error);

      // Show error message to user
      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening user management modal. Please try again.',
        });
      }
    }
  });

  // Handler for CHOIR users modal submission
  app.view('choir_users_modal', async ({ ack, body, client, logger, view }) => {
    try {
      const selectedUsers = view.state.values.choir_users_select_block.choir_users_select.selected_users || [];

      if (selectedUsers.length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            choir_users_select_block: 'Please select at least one user or cancel to keep current settings.',
          },
        });
        return;
      }

      // Get workspace ID
      const workspaceId = await getWorkspaceId(client);

      // Update CHOIR users
      const success = await setCHOIRUsers(workspaceId, selectedUsers);

      if (success) {
        await ack();

        // Show success message
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ CHOIR users updated successfully! ${selectedUsers.length} users are now registered. Please refresh your app home to see the changes.`,
        });

        // Auto-refresh home screen
        setTimeout(async () => {
          try {
            const mockEvent = {
              type: 'app_home_opened' as const,
              user: body.user.id,
              tab: 'home' as const,
              event_ts: Date.now().toString(),
            };

            const handlerArgs = {
              client,
              event: mockEvent,
              logger,
              context: {},
              payload: mockEvent,
            };

            await appHomeOpenedCallback(handlerArgs as any);
            logger.info(`Home screen refreshed for user ${body.user.id} after CHOIR users update`);
          } catch (error) {
            logger.error('Error refreshing home view after CHOIR users update:', error);
          }
        }, 1000);

        logger.info('CHOIR users updated via modal', {
          workspaceId,
          userId: body.user.id,
          userCount: selectedUsers.length,
        });
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            choir_users_select_block: 'Failed to update CHOIR users. Please try again.',
          },
        });
      }
    } catch (error) {
      logger.error('Error processing CHOIR users modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          choir_users_select_block: 'An error occurred while updating users. Please try again.',
        },
      });
    }
  });

  // Handler for password modal submission
  app.view('manager_password_modal', async ({ ack, body, client, logger, view }) => {
    try {
      const password = view.state.values.password_input.password_value.value;

      if (!password) {
        await ack({
          response_action: 'errors',
          errors: {
            password_input: 'Password is required',
          },
        });
        return;
      }

      // Get workspace ID
      const workspaceId = await getWorkspaceId(client);

      // Attempt to promote user to manager
      const success = await promoteToManagerWithPassword(workspaceId, body.user.id, password);

      if (success) {
        await ack();

        // Show success message
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '🎉 Welcome! You are now a manager and have access to all features. Please refresh your app home to see the changes.',
        });

        logger.info('User promoted to manager via password', { workspaceId, userId: body.user.id });
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            password_input: 'Invalid password. Please try again.',
          },
        });
      }
    } catch (error) {
      logger.error('Error processing manager password modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          password_input: 'An error occurred. Please try again.',
        },
      });
    }
  });

  // Handler for connecting personal GitHub account
  app.action('connect_personal_github', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      // Import GitHub OAuth Device Flow service
      const { GitHubOAuthDeviceFlow } = await import('services/github/oauth-device-flow');
      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();

      // Request device code
      const deviceCode = await githubOAuth.requestDeviceCode();

      // Show device code modal
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'github_device_code_modal',
          title: {
            type: 'plain_text',
            text: 'Connect GitHub',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '🔐 *Connect your GitHub account*\n\nTo connect your GitHub account, please follow these steps:',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `1. Go to: *<${deviceCode.verification_uri}|${deviceCode.verification_uri}>*\n2. Enter this code: \`${deviceCode.user_code}\`\n3. Authorize CHOIR to access your GitHub account`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⏰ *Code expires in ${Math.floor(deviceCode.expires_in / 60)} minutes*`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '💡 This window will automatically close once you complete the authorization on GitHub.',
                },
              ],
            },
          ],
          private_metadata: JSON.stringify({
            deviceCode: deviceCode.device_code,
            userId,
            workspaceId,
          }),
        },
      });

      // Start polling for access token in background
      setTimeout(async () => {
        try {
          const tokenResponse = await githubOAuth.pollForAccessToken(deviceCode.device_code, deviceCode.interval);
          const user = await githubOAuth.getUserInfo(tokenResponse.access_token);

          // Store the token
          const workspaceStore = new WorkspaceStore();
          await workspaceStore.setUserGithubToken(workspaceId, userId, {
            accessToken: tokenResponse.access_token,
            user,
          });

          // Close any open modals and refresh home view
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: `✅ GitHub account connected successfully! Welcome, ${user.name || user.login}!`,
          });

          // Refresh home view
          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
            tab: 'home' as const,
            event_ts: Date.now().toString(),
          };

          const handlerArgs = {
            client,
            event: mockEvent,
            logger,
            context: {},
            payload: mockEvent,
          };

          await appHomeOpenedCallback(handlerArgs as any);
          logger.info(`GitHub connected for user ${userId} in workspace ${workspaceId}`);
        } catch (error) {
          logger.error('Error during GitHub OAuth flow:', error);
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: '❌ GitHub connection failed. Please try again.',
          });
        }
      }, 2000);
    } catch (error) {
      logger.error('Error initiating GitHub connection:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error starting GitHub connection. Please try again.',
      });
    }
  });

  // Handler for disconnecting personal GitHub account
  app.action('disconnect_personal_github', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      const workspaceStore = new WorkspaceStore();
      await workspaceStore.removeUserGithubToken(workspaceId, userId);

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: '✅ GitHub account disconnected successfully.',
      });

      // Refresh home view
      const mockEvent = {
        type: 'app_home_opened' as const,
        user: userId,
        tab: 'home' as const,
        event_ts: Date.now().toString(),
      };

      const handlerArgs = {
        client,
        event: mockEvent,
        logger,
        context: {},
        payload: mockEvent,
      };

      await appHomeOpenedCallback(handlerArgs as any);
      logger.info(`GitHub disconnected for user ${userId} in workspace ${workspaceId}`);
    } catch (error) {
      logger.error('Error disconnecting GitHub:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error disconnecting GitHub. Please try again.',
      });
    }
  });

  // Handler for browsing GitHub repositories
  app.action('browse_github_repositories', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      // Get user's GitHub token
      const workspaceStore = new WorkspaceStore();
      const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);

      if (!userGithubInfo) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: '❌ GitHub account not connected. Please connect your GitHub account first.',
        });
        return;
      }

      // Get user's repositories
      const { GitHubOAuthDeviceFlow } = await import('services/github/oauth-device-flow');
      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();
      
      const allRepositories = await githubOAuth.getRepositoriesWithMarkdown(userGithubInfo.accessToken);

      if (allRepositories.length === 0) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: '📂 No repositories found with write access. Make sure you have push permissions to your repositories.',
        });
        return;
      }

      // Filter and sort repositories: most recently updated first, limit to 10
      const repositories = allRepositories
        .filter(repo => repo.permissions && (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 10);

      if (repositories.length === 0) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: '📂 No repositories found with push access. Make sure you have write permissions to your repositories.',
        });
        return;
      }

      // Create repository selection options
      const options = repositories.map((repo, index) => ({
        text: {
          type: 'plain_text' as const,
          text: `${repo.full_name}${repo.private ? ' 🔒' : ''} (${new Date(repo.updated_at).toLocaleDateString()})`,
          emoji: true,
        },
        value: `${index}`,
      }));

      // Store minimal repository data in modal's private_metadata
      const repositoryData = repositories.map(repo => ({
        owner: repo.owner.login,
        repo: repo.name,
        full_name: repo.full_name,
        default_branch: repo.default_branch,
        private: repo.private,
      }));

      // Show repository selection modal
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'github_repository_selection_modal',
          title: {
            type: 'plain_text',
            text: 'Select Repository',
          },
          submit: {
            type: 'plain_text',
            text: 'Connect',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📁 *Select a repository to connect*\n\nShowing your ${repositories.length} most recently updated repositories with push access${allRepositories.length > repositories.length ? ` (${allRepositories.length} total repositories found)` : ''}.`,
              },
            },
            {
              type: 'input',
              block_id: 'repository_select_block',
              element: {
                type: 'static_select',
                action_id: 'repository_select',
                placeholder: {
                  type: 'plain_text',
                  text: 'Choose a repository...',
                },
                options,
              },
              label: {
                type: 'plain_text',
                text: 'Repository',
              },
            },
            {
              type: 'input',
              block_id: 'repository_path_block',
              element: {
                type: 'plain_text_input',
                action_id: 'repository_path',
                placeholder: {
                  type: 'plain_text',
                  text: 'docs/ (optional)',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Path (optional)',
              },
              hint: {
                type: 'plain_text',
                text: 'Specify a subdirectory if markdown files are in a specific folder',
              },
              optional: true,
            },
          ],
          private_metadata: JSON.stringify({
            repositories: repositoryData,
            userId,
            workspaceId,
          }),
        },
      });

      logger.info(`Showing ${repositories.length} repositories for user ${userId}`);
    } catch (error) {
      logger.error('Error browsing GitHub repositories:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error loading repositories. Please try again.',
      });
    }
  });

  // Handler for repository selection modal submission
  app.view('github_repository_selection_modal', async ({ ack, body, client, logger, view }) => {
    try {
      const selectedRepo = view.state.values.repository_select_block.repository_select.selected_option;
      const pathInput = view.state.values.repository_path_block.repository_path.value;

      if (!selectedRepo) {
        await ack({
          response_action: 'errors',
          errors: {
            repository_select_block: 'Please select a repository.',
          },
        });
        return;
      }

      // Get repository data from private_metadata
      const metadata = JSON.parse(view.private_metadata);
      const repositoryIndex = parseInt(selectedRepo.value);
      const repoData = metadata.repositories[repositoryIndex];
      const repoInfo = {
        owner: repoData.owner,
        repo: repoData.repo,
        path: pathInput || '',
        branch: repoData.default_branch,
        url: `https://github.com/${repoData.owner}/${repoData.repo}`,
      };

      await ack();

      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      // Store the GitHub repository info
      await storeGithubRepo(workspaceId, repoInfo);

      // Get user's GitHub token for loading files
      const workspaceStore = new WorkspaceStore();
      const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);

      if (!userGithubInfo) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: '❌ GitHub account not connected.',
        });
        return;
      }

      // Load markdown files from the selected repository
      let markdownFiles = [];
      try {
        const githubService = GithubService.getInstance();
        // We'll need to modify the GitHub service to use user tokens
        logger.info(`Loading markdown files from ${repoInfo.owner}/${repoInfo.repo}`);
        markdownFiles = await githubService.getAllMarkdownFiles({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          path: repoInfo.path || '',
        });
        logger.info(`Successfully loaded ${markdownFiles.length} files from repository`);

        // Cache file list in workspace settings
        const fileList = markdownFiles.map((file: any) => ({
          name: file.name,
          path: file.path,
        }));
        await workspaceStore.setMarkdownFilesCache(workspaceId, fileList);
        logger.info(`Cached ${fileList.length} markdown files in workspace configuration`);

        // Update vector store
        const vectorStore = VectorStoreService.getInstance();
        await vectorStore.setMarkdownFiles(markdownFiles, {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
        });
        logger.info(`Vector store rebuilt with ${markdownFiles.length} files from selected repository for workspace ${workspaceId}`);
      } catch (error) {
        logger.error('Error loading files from selected repository:', error);
      }

      // Send success message
      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: `✅ Repository "${repoData.full_name}" connected successfully!\n📁 Loading ${markdownFiles.length} markdown files...`,
      });

      // Refresh home view
      setTimeout(async () => {
        try {
          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
            tab: 'home' as const,
            event_ts: Date.now().toString(),
          };

          const handlerArgs = {
            client,
            event: mockEvent,
            logger,
            context: {},
            payload: mockEvent,
          };

          await appHomeOpenedCallback(handlerArgs as any);
          logger.info(`Home screen refreshed for user ${userId} after repository connection`);

          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: `🎉 All done! Repository "${repoData.full_name}" is now connected and ready to use.`,
          });
        } catch (error) {
          logger.error('Error refreshing home view:', error);
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: '🎉 Repository connected successfully! Please refresh the Home tab to see the updated connection.',
          });
        }
      }, 1500);

    } catch (error) {
      logger.error('Error processing repository selection:', error);

      await ack({
        response_action: 'errors',
        errors: {
          repository_select_block: 'An error occurred while connecting the repository. Please try again.',
        },
      });
    }
  });
};

export default { register };
export { appHomeOpenedCallback };
