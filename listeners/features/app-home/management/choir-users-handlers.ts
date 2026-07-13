import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getCHOIRUsers, getWorkspaceId, setCHOIRUsers } from 'services/slack';
import { logManagementButtonError, refreshAppHomeSoon, requireManagerForAction } from './shared';

export const registerChoirUsersHandlers = (app: App) => {
  app.action('manage_choir_users', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) {
        return;
      }

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

      await logManagementButtonError({
        userId: body.user.id,
        actionId: 'manage_choir_users',
        actionLabel: 'Manage CHOIR Users',
        startTime,
        error,
        client,
        logger,
      });
    }
  });

  app.view('choir_users_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) {
        await ack();
        return;
      }

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

        refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'CHOIR users update' });

        logger.info('CHOIR users updated via modal', {
          workspaceId,
          userId: body.user.id,
          userCount: selectedUsers.length,
        });

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
};
