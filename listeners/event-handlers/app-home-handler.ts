import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
import {
  getChannelName,
  getGithubRepo,
  getManagers,
  getOrganizationDescription,
  getOrganizationName,
  getQAChannel,
  getWorkspaceId,
  isManager,
  isWorkspaceOwner,
  setOrganizationDescription,
  setOrganizationName,
} from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { AppConfig } from '@/config';

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

    // Get current manager list
    const managers = await getManagers(workspaceId);

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
                text: 'Rebuild Cache',
                emoji: true,
              },
              style: 'primary',
              action_id: 'rebuild_vector_cache',
            },
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
                text: 'Emergency Reset',
                emoji: true,
              },
              style: 'danger',
              action_id: 'reset_vector_store',
              confirm: {
                title: {
                  type: 'plain_text',
                  text: 'Are you sure?',
                },
                text: {
                  type: 'plain_text',
                  text: 'This will completely reset the vector store and rebuild it. This action cannot be undone.',
                },
                confirm: {
                  type: 'plain_text',
                  text: 'Execute Reset',
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
                text: 'Select Q&A Channel',
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

    // GitHub repository connection section
    const githubBlocks = [];

    // Show GitHub connection UI only for managers or workspace owners
    if (isUserManager || isOwner) {
      // Get current connected GitHub repository info
      let repoInfo = await getGithubRepo(workspaceId);
      
      // If no repository is configured, show default repository info
      if (!repoInfo) {
        const defaultRepo = AppConfig.getDefaultRepo();
        repoInfo = {
          owner: defaultRepo.owner,
          repo: defaultRepo.repo,
          path: '',
          url: `https://github.com/${defaultRepo.owner}/${defaultRepo.repo}`,
        };
      }
      
      logger.info(`GitHub repo info for workspace ${workspaceId}:`, repoInfo);

      githubBlocks.push({
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🔗 GitHub Repository Connection',
          emoji: true,
        },
      });

      // Show current connection status
      const savedRepoInfo = await getGithubRepo(workspaceId);
      if (savedRepoInfo) {
        githubBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Currently Connected Repository*\n<${savedRepoInfo.url}|${savedRepoInfo.owner}/${savedRepoInfo.repo}${
              savedRepoInfo.path ? ` (Path: ${savedRepoInfo.path})` : ''
            }>`,
          },
        });
      } else {
        const defaultRepo = AppConfig.getDefaultRepo();
        githubBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Currently Using Default Repository*\n<https://github.com/${defaultRepo.owner}/${defaultRepo.repo}|${defaultRepo.owner}/${defaultRepo.repo}> (${process.env.NODE_ENV} mode)\n\nConnect a custom repository below to override this default.`,
          },
        });
      }

      // GitHub repository input form
      githubBlocks.push(
        {
          type: 'input',
          block_id: 'github_repo_url_input_block',
          dispatch_action: true,
          element: {
            type: 'plain_text_input',
            action_id: 'github_repo_url_input',
            placeholder: {
              type: 'plain_text',
              text: 'https://github.com/username/repo',
            },
          },
          label: {
            type: 'plain_text',
            text: 'GitHub Repository URL',
          },
          hint: {
            type: 'plain_text',
            text: 'Enter GitHub repository URL, then click Connect Repository',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Connect Repository',
                emoji: true,
              },
              style: 'primary',
              action_id: 'connect_github_repository',
            },
          ],
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

    // Combine all blocks
    const blocks = [
      ...homeBlocks,
      ...managerManagementBlocks,
      ...managerBlocks,
      ...organizationDescriptionBlocks,
      ...qaChannelBlocks,
      ...vectorStoreBlocks,
      ...githubBlocks,
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
};

export default { register };
export { appHomeOpenedCallback };
