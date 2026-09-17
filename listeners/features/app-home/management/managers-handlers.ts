import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { addManager, getManagers, getWorkspaceId, isManager, isWorkspaceOwner, removeManager } from 'services/slack';
import { logManagementButtonError, logManagementModalError, refreshAppHomeSoon } from './shared';

export const registerManagersHandlers = (app: App) => {
  app.action('manage_managers', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const t = tForRequest(context);

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
            text: t('appHome.management.managers.title'),
          },
          submit: {
            type: 'plain_text',
            text: t('appHome.management.managers.submit'),
          },
          close: {
            type: 'plain_text',
            text: t('common.button.cancel'),
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.managers.intro'),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.managers.status', { count: managers.length }),
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
                  text: t('appHome.management.managers.placeholder'),
                },
              },
              label: {
                type: 'plain_text',
                text: t('appHome.management.managers.label'),
              },
              hint: {
                type: 'plain_text',
                text: t('appHome.management.managers.hint'),
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: t('appHome.management.managers.warning'),
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
          text: t('appHome.management.managers.error.open'),
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

  app.view('managers_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    const t = tForRequest(context);

    try {
      const selectedUsers = view.state.values.managers_select_block.managers_select.selected_users || [];

      if (selectedUsers.length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            managers_select_block: t('appHome.management.managers.error.empty'),
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
      const currentUser = body.user.id;

      // Only a manager or the workspace owner may change the manager roster.
      const [actorIsManager, actorIsOwner] = await Promise.all([
        isManager(workspaceId, currentUser),
        isWorkspaceOwner(currentUser, client),
      ]);
      if (!actorIsManager && !actorIsOwner) {
        await ack();
        await client.chat.postEphemeral({
          user: currentUser,
          channel: currentUser,
          text: t('appHome.management.managers.error.permission'),
        });
        return;
      }

      const currentManagers = await getManagers(workspaceId);
      const managersToAdd = selectedUsers.filter((userId) => !currentManagers.includes(userId));
      const managersToRemove = currentManagers.filter((userId) => !selectedUsers.includes(userId));

      let success = true;
      const results = [];

      for (const userId of managersToAdd) {
        try {
          // Pass actorIsOwner so an owner not listed as a manager can still grant.
          const addResult = await addManager(workspaceId, userId, currentUser, { actorIsOwner });
          if (addResult) {
            results.push(t('appHome.management.managers.result.added', { user: `<@${userId}>` }));
          } else {
            results.push(t('appHome.management.managers.result.addFailed', { user: `<@${userId}>` }));
            success = false;
          }
        } catch (error) {
          logger.error(`Error adding manager ${userId}:`, error);
          results.push(t('appHome.management.managers.result.addError', { user: `<@${userId}>` }));
          success = false;
        }
      }

      for (const userId of managersToRemove) {
        try {
          const removeResult = await removeManager(workspaceId, userId, currentUser, { actorIsOwner });
          if (removeResult) {
            results.push(t('appHome.management.managers.result.removed', { user: `<@${userId}>` }));
          } else {
            results.push(t('appHome.management.managers.result.removeFailed', { user: `<@${userId}>` }));
            success = false;
          }
        } catch (error) {
          logger.error(`Error removing manager ${userId}:`, error);
          results.push(t('appHome.management.managers.result.removeError', { user: `<@${userId}>` }));
          success = false;
        }
      }

      if (success && (managersToAdd.length > 0 || managersToRemove.length > 0)) {
        await ack();

        const changesText = results.length > 0 ? `\n\n${results.join('\n')}` : '';
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.management.managers.updated', { count: selectedUsers.length, changes: changesText }),
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
          text: t('appHome.management.managers.noChanges'),
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
            managers_select_block: t('appHome.management.managers.error.partial'),
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
          managers_select_block: t('appHome.management.managers.error.generic'),
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
