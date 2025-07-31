import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/user-interaction-logger';
import {
  addManager,
  getCHOIRUsers,
  getManagers,
  getWorkspaceId,
  promoteToManagerWithPassword,
  removeManager,
  setCHOIRUsers,
} from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

export const registerManagementHandlers = (app: App) => {
  app.action('request_manager_permission', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'manager_promotion_modal',
          notify_on_close: true,
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

      // Log success
      const workspaceId = await getWorkspaceId(client);
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'request_manager_permission',
        Date.now() - startTime,
        true,
        'Become Manager',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error opening manager promotion modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening manager promotion modal. Please try again.',
        });
      }

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeButtonClick(
          body.user.id,
          workspaceId,
          'request_manager_permission',
          Date.now() - startTime,
          false,
          'Become Manager',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.view('manager_promotion_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      const password = view.state.values.password_block.password_input.value;

      if (!password) {
        await ack({
          response_action: 'errors',
          errors: {
            password_block: 'Please enter the promotion password.',
          },
        });

        // Log validation error
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'manager_promotion_modal',
          Date.now() - startTime,
          false,
          'Manager promotion with empty password',
          {
            error: 'Empty password',
          },
          client,
        );
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

        // Log successful promotion
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'manager_promotion_modal',
          Date.now() - startTime,
          true,
          `Manager promotion with password: ${password}`,
          {
            promoted: true,
          },
          client,
        );
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            password_block: 'Invalid password. Please check the password and try again.',
          },
        });

        // Log invalid password
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'manager_promotion_modal',
          Date.now() - startTime,
          false,
          `Manager promotion with invalid password: ${password}`,
          {
            error: 'Invalid password',
          },
          client,
        );
      }
    } catch (error) {
      logger.error('Error processing manager promotion modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          password_block: 'An error occurred while processing your request. Please try again.',
        },
      });

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'manager_promotion_modal',
          Date.now() - startTime,
          false,
          `Manager promotion error`,
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.action('manage_choir_users', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const choirUsers = await getCHOIRUsers(workspaceId);

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'choir_users_modal',
          notify_on_close: true,
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

      // Log success
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'manage_choir_users',
        Date.now() - startTime,
        true,
        'Manage CHOIR Users',
        {
          currentUsersCount: choirUsers.length,
        },
        client,
      );
    } catch (error) {
      logger.error('Error opening CHOIR users management modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening user management modal. Please try again.',
        });
      }

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeButtonClick(
          body.user.id,
          workspaceId,
          'manage_choir_users',
          Date.now() - startTime,
          false,
          'Manage CHOIR Users',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.view('choir_users_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

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

        // Log successful update
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'choir_users_modal',
          Date.now() - startTime,
          true,
          `CHOIR users updated: ${selectedUsers.join(', ')}`,
          {
            usersCount: selectedUsers.length,
            selectedUsers: selectedUsers,
          },
          client,
        );
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            choir_users_select_block: 'Failed to update CHOIR users. Please try again.',
          },
        });

        // Log update failure
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'choir_users_modal',
          Date.now() - startTime,
          false,
          `CHOIR users update failed: ${selectedUsers.join(', ')}`,
          {
            error: 'Failed to update CHOIR users',
            usersCount: selectedUsers.length,
            selectedUsers: selectedUsers,
          },
          client,
        );
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
    const startTime = Date.now();
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
          notify_on_close: true,
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

      // Log success
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'manage_managers',
        Date.now() - startTime,
        true,
        'Manage Managers',
        {
          managersCount: managers.length,
          managerIds: managers,
          managerInfos: managerInfos.map(info => ({
            id: info.id,
            name: info.name,
            displayName: info.displayName
          })),
        },
        client,
      );
    } catch (error) {
      logger.error('Error opening managers management modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening manager management modal. Please try again.',
        });
      }

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeButtonClick(
          body.user.id,
          workspaceId,
          'manage_managers',
          Date.now() - startTime,
          false,
          'Manage Managers',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.view('managers_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      const selectedUsers = view.state.values.managers_select_block.managers_select.selected_users || [];

      if (selectedUsers.length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            managers_select_block: 'Please select at least one manager or cancel to keep current settings.',
          },
        });

        // Log validation error
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'managers_modal',
          Date.now() - startTime,
          false,
          'Managers modal submitted with no users selected',
          {
            error: 'No users selected',
          },
          client,
        );
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

        // Log successful update
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'managers_modal',
          Date.now() - startTime,
          true,
          `Managers updated - Added: ${managersToAdd.join(', ')}, Removed: ${managersToRemove.join(', ')}, Total: ${selectedUsers.join(', ')}`,
          {
            managersAdded: managersToAdd,
            managersRemoved: managersToRemove,
            selectedManagers: selectedUsers,
            totalManagers: selectedUsers.length,
            addedCount: managersToAdd.length,
            removedCount: managersToRemove.length,
          },
          client,
        );
      } else if (managersToAdd.length === 0 && managersToRemove.length === 0) {
        await ack();
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '✅ No changes made to manager permissions.',
        });

        // Log no changes made
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'managers_modal',
          Date.now() - startTime,
          true,
          `Managers modal submitted with no changes - Current managers: ${selectedUsers.join(', ')}`,
          {
            selectedManagers: selectedUsers,
            totalManagers: selectedUsers.length,
            noChanges: true,
          },
          client,
        );
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            managers_select_block: 'Some manager permission changes failed. Please try again.',
          },
        });

        // Log partial failure
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'managers_modal',
          Date.now() - startTime,
          false,
          `Managers update partially failed - Added: ${managersToAdd.join(', ')}, Removed: ${managersToRemove.join(', ')}, Selected: ${selectedUsers.join(', ')}`,
          {
            error: 'Some manager permission changes failed',
            managersAdded: managersToAdd,
            managersRemoved: managersToRemove,
            selectedManagers: selectedUsers,
            results: results,
          },
          client,
        );
      }
    } catch (error) {
      logger.error('Error processing managers modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          managers_select_block: 'An error occurred while updating managers. Please try again.',
        },
      });

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'managers_modal',
          Date.now() - startTime,
          false,
          'Managers modal error',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.action('toggle_logging', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
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

      // Log success
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'toggle_logging',
        Date.now() - startTime,
        true,
        'Toggle Logging',
        {
          previousState: currentLogging,
          newState: newLogging,
        },
        client,
      );
    } catch (error) {
      logger.error('Error toggling logging setting:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '\u274c Error toggling logging setting. Please try again.',
        });
      }

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeButtonClick(
          body.user.id,
          workspaceId,
          'toggle_logging',
          Date.now() - startTime,
          false,
          'Toggle Logging',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.action('manage_readonly_files', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const readOnlyFiles = await workspaceStore.getReadOnlyFiles(workspaceId);
      const markdownFiles = await workspaceStore.getCachedMarkdownFiles(workspaceId);

      if (!markdownFiles || markdownFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No markdown files found. Please connect to a GitHub repository first.',
        });
        return;
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'readonly_files_modal',
          notify_on_close: true,
          title: {
            type: 'plain_text',
            text: 'Manage Read-Only Files',
          },
          submit: {
            type: 'plain_text',
            text: 'Update Files',
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
                text: '🔒 *Select Read-Only Files*\n\nRead-only files are excluded from document updates but remain searchable. Choose which files should be protected from automatic updates.',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📊 *Current Status:* ${readOnlyFiles.length} of ${markdownFiles.length} files are read-only`,
              },
            },
            {
              type: 'input',
              block_id: 'readonly_files_select_block',
              element: {
                type: 'multi_static_select',
                action_id: 'readonly_files_select',
                ...(readOnlyFiles.length > 0 && {
                  initial_options: readOnlyFiles
                    .filter((fileName) => markdownFiles.some((file) => file.name === fileName))
                    .map((fileName) => ({
                      text: {
                        type: 'plain_text',
                        text: fileName,
                      },
                      value: fileName,
                    })),
                }),
                options: markdownFiles.map((file) => ({
                  text: {
                    type: 'plain_text',
                    text: file.name,
                  },
                  value: file.name,
                })),
                placeholder: {
                  type: 'plain_text',
                  text: 'Select files to mark as read-only...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Select files to mark as read-only',
              },
              optional: true,
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: "💡 *Tip:* Read-only files can still be searched and referenced, but they won't be modified during document updates.",
                },
              ],
            },
          ],
        },
      });

      // Log success
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'manage_readonly_files',
        Date.now() - startTime,
        true,
        'Manage Read-Only Files',
        {
          currentReadOnlyCount: readOnlyFiles.length,
          totalFilesCount: markdownFiles.length,
        },
        client,
      );
    } catch (error) {
      logger.error('Error opening read-only files management modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening read-only files management modal. Please try again.',
        });
      }

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeButtonClick(
          body.user.id,
          workspaceId,
          'manage_readonly_files',
          Date.now() - startTime,
          false,
          'Manage Read-Only Files',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });

  app.view('readonly_files_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      const selectedFiles =
        view.state.values.readonly_files_select_block.readonly_files_select.selected_options?.map(
          (option) => option.value,
        ) || [];

      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();

      const success = await workspaceStore.setReadOnlyFiles(workspaceId, selectedFiles);

      if (success) {
        await ack();

        // Update writable files index after changing read-only files configuration
        const vectorStore = VectorStoreService.getInstance();
        try {
          await vectorStore.updateReadOnlyFilesConfiguration(workspaceId);
          logger.info('Successfully updated writable files index after read-only files change');
        } catch (vectorError) {
          logger.warn('Failed to update writable files index:', vectorError);
        }

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ Read-only files updated successfully! ${selectedFiles.length} files are now marked as read-only. Please refresh your app home to see the changes.`,
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
            logger.info(`Home screen refreshed for user ${body.user.id} after read-only files update`);
          } catch (error) {
            logger.error('Error refreshing home view after read-only files update:', error);
          }
        }, 1000);

        logger.info('Read-only files updated via modal', {
          workspaceId,
          userId: body.user.id,
          readOnlyFilesCount: selectedFiles.length,
          readOnlyFiles: selectedFiles,
        });

        // Log successful update  
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'readonly_files_modal',
          Date.now() - startTime,
          true,
          `Read-only files updated: ${selectedFiles.join(', ')}`,
          {
            readOnlyFilesCount: selectedFiles.length,
            readOnlyFiles: selectedFiles,
          },
          client,
        );
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            readonly_files_select_block: 'Failed to update read-only files. Please try again.',
          },
        });

        // Log update failure
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'readonly_files_modal',
          Date.now() - startTime,
          false,
          `Read-only files update failed: ${selectedFiles.join(', ')}`,
          {
            error: 'Failed to update read-only files',
            readOnlyFilesCount: selectedFiles.length,
            readOnlyFiles: selectedFiles,
          },
          client,
        );
      }
    } catch (error) {
      logger.error('Error processing read-only files modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          readonly_files_select_block: 'An error occurred while updating read-only files. Please try again.',
        },
      });

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'readonly_files_modal',
          Date.now() - startTime,
          false,
          'Read-only files modal error',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });
};
