import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { addManager, getManagers, getWorkspaceId, removeManager } from 'services/slack';
import { logManagementButtonError, logManagementModalError, refreshAppHomeSoon } from './shared';

export const registerManagersHandlers = (app: App) => {
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
          managerInfos: managerInfos.map((info) => ({
            id: info.id,
            name: info.name,
            displayName: info.displayName,
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

      await logManagementButtonError({
        userId: body.user.id,
        actionId: 'manage_managers',
        actionLabel: 'Manage Managers',
        startTime,
        error,
        client,
        logger,
      });
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

        refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'managers update' });

        logger.info('Managers updated via modal', {
          workspaceId,
          userId: body.user.id,
          managersAdded: managersToAdd,
          managersRemoved: managersToRemove,
          totalManagers: selectedUsers.length,
        });

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

      await logManagementModalError({
        userId: body.user.id,
        callbackId: 'managers_modal',
        message: 'Managers modal error',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
