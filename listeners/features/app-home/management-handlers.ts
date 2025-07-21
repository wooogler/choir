import type { App } from '@slack/bolt';
import {
  addManager,
  getCHOIRUsers,
  getManagers,
  getWorkspaceId,
  promoteToManagerWithPassword,
  removeManager,
  setCHOIRUsers,
} from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

export const registerManagementHandlers = (app: App) => {
  app.action('request_manager_permission', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'manager_promotion_modal',
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
                text: '🔐 *Manager Promotion*\n\nEnter the manager promotion password to gain manager permissions.',
              },
            },
            {
              type: 'input',
              block_id: 'password_block',
              element: {
                type: 'plain_text_input',
                action_id: 'password_input',
                placeholder: {
                  type: 'plain_text',
                  text: 'Enter promotion password...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Password',
              },
            },
          ],
        },
      });
    } catch (error) {
      logger.error('Error opening manager promotion modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening manager promotion modal. Please try again.',
        });
      }
    }
  });

  app.view('manager_promotion_modal', async ({ ack, body, client, logger, view }) => {
    try {
      const password = view.state.values.password_block.password_input.value;

      if (!password) {
        await ack({
          response_action: 'errors',
          errors: {
            password_block: 'Please enter the promotion password.',
          },
        });
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      const success = await promoteToManagerWithPassword(workspaceId, userId, password);

      if (success) {
        await ack();

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '✅ Congratulations! You have been promoted to manager. Please refresh your app home to see the changes.',
        });

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
            logger.info(`Home screen refreshed for user ${body.user.id} after manager promotion`);
          } catch (error) {
            logger.error('Error refreshing home view after manager promotion:', error);
          }
        }, 1000);

        logger.info('User promoted to manager via password', {
          workspaceId,
          userId,
        });
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            password_block: 'Invalid password. Please check the password and try again.',
          },
        });
      }
    } catch (error) {
      logger.error('Error processing manager promotion modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          password_block: 'An error occurred while processing your request. Please try again.',
        },
      });
    }
  });

  app.action('manage_choir_users', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const choirUsers = await getCHOIRUsers(workspaceId);

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

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening user management modal. Please try again.',
        });
      }
    }
  });

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

      const workspaceId = await getWorkspaceId(client);

      const success = await setCHOIRUsers(workspaceId, selectedUsers, client);

      if (success) {
        await ack();

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ CHOIR users updated successfully! ${selectedUsers.length} users are now registered. Please refresh your app home to see the changes.`,
        });

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

  app.action('manage_managers', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const managers = await getManagers(workspaceId);

      const managerInfos = [];
      for (const managerId of managers) {
        try {
          const userInfo = await client.users.info({ user: managerId });
          const name = userInfo.user?.real_name || userInfo.user?.name || 'Unknown User';
          managerInfos.push({
            id: managerId,
            name,
            displayName: `${name} (@${userInfo.user?.name || 'unknown'})`,
          });
        } catch (error) {
          logger.error(`Failed to get user info for manager ${managerId}:`, error);
          managerInfos.push({
            id: managerId,
            name: 'Unknown User',
            displayName: `Unknown User (@${managerId})`,
          });
        }
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'managers_modal',
          title: {
            type: 'plain_text',
            text: 'Manage Managers',
          },
          submit: {
            type: 'plain_text',
            text: 'Update Managers',
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
                text: '👑 *Select Managers*\n\nChoose which workspace members should have manager permissions. Managers can access advanced features and grant permissions to other users.',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📊 *Current Status:* ${managers.length} managers assigned`,
              },
            },
            {
              type: 'input',
              block_id: 'managers_select_block',
              element: {
                type: 'multi_users_select',
                action_id: 'managers_select',
                initial_users: managers,
                placeholder: {
                  type: 'plain_text',
                  text: 'Select users to be managers...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Managers',
              },
              hint: {
                type: 'plain_text',
                text: 'Selected users will have manager permissions and access to all CHOIR management features.',
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '⚠️ *Important:* Removing manager permissions may affect their ability to manage CHOIR settings.',
                },
              ],
            },
          ],
        },
      });
    } catch (error) {
      logger.error('Error opening managers management modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening manager management modal. Please try again.',
        });
      }
    }
  });

  app.view('managers_modal', async ({ ack, body, client, logger, view }) => {
    try {
      const selectedUsers = view.state.values.managers_select_block.managers_select.selected_users || [];

      if (selectedUsers.length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            managers_select_block: 'Please select at least one manager or cancel to keep current settings.',
          },
        });
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const currentManagers = await getManagers(workspaceId);
      const currentUser = body.user.id;

      const managersToAdd = selectedUsers.filter((userId) => !currentManagers.includes(userId));
      const managersToRemove = currentManagers.filter((userId) => !selectedUsers.includes(userId));

      let success = true;
      const results = [];

      for (const userId of managersToAdd) {
        try {
          const addResult = await addManager(workspaceId, userId, currentUser);
          if (addResult) {
            results.push(`✅ Added manager permission for <@${userId}>`);
          } else {
            results.push(`❌ Failed to add manager permission for <@${userId}>`);
            success = false;
          }
        } catch (error) {
          logger.error(`Error adding manager ${userId}:`, error);
          results.push(`❌ Error adding manager permission for <@${userId}>`);
          success = false;
        }
      }

      for (const userId of managersToRemove) {
        try {
          const removeResult = await removeManager(workspaceId, userId, currentUser);
          if (removeResult) {
            results.push(`✅ Removed manager permission from <@${userId}>`);
          } else {
            results.push(`❌ Failed to remove manager permission from <@${userId}>`);
            success = false;
          }
        } catch (error) {
          logger.error(`Error removing manager ${userId}:`, error);
          results.push(`❌ Error removing manager permission from <@${userId}>`);
          success = false;
        }
      }

      if (success && (managersToAdd.length > 0 || managersToRemove.length > 0)) {
        await ack();

        const changesText = results.length > 0 ? `\n\n${results.join('\n')}` : '';
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ Manager permissions updated successfully! ${selectedUsers.length} managers are now assigned.${changesText}`,
        });

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
            logger.info(`Home screen refreshed for user ${body.user.id} after managers update`);
          } catch (error) {
            logger.error('Error refreshing home view after managers update:', error);
          }
        }, 1000);

        logger.info('Managers updated via modal', {
          workspaceId,
          userId: body.user.id,
          managersAdded: managersToAdd,
          managersRemoved: managersToRemove,
          totalManagers: selectedUsers.length,
        });
      } else if (managersToAdd.length === 0 && managersToRemove.length === 0) {
        await ack();
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '✅ No changes made to manager permissions.',
        });
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            managers_select_block: 'Some manager permission changes failed. Please try again.',
          },
        });
      }
    } catch (error) {
      logger.error('Error processing managers modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          managers_select_block: 'An error occurred while updating managers. Please try again.',
        },
      });
    }
  });

  app.action('toggle_logging', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const currentLogging = await workspaceStore.getLoggingEnabled(workspaceId);
      const newLogging = !currentLogging;
      
      await workspaceStore.setLoggingEnabled(workspaceId, newLogging);

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: `${newLogging ? '\u2705' : '\u274c'} Logging has been ${newLogging ? 'enabled' : 'disabled'}. Please refresh your app home to see the changes.`,
      });

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
          logger.info(`Home screen refreshed for user ${body.user.id} after logging toggle`);
        } catch (error) {
          logger.error('Error refreshing home view after logging toggle:', error);
        }
      }, 1000);

      logger.info('Logging setting toggled', {
        workspaceId,
        userId: body.user.id,
        enabled: newLogging,
      });
    } catch (error) {
      logger.error('Error toggling logging setting:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '\u274c Error toggling logging setting. Please try again.',
        });
      }
    }
  });
};
