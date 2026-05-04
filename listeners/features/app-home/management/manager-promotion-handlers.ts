import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getWorkspaceId, promoteToManagerWithPassword } from 'services/slack';
import { logManagementButtonError, logManagementModalError, refreshAppHomeSoon } from './shared';

export const registerManagerPromotionHandlers = (app: App) => {
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

      await logManagementButtonError({
        userId: body.user.id,
        actionId: 'request_manager_permission',
        actionLabel: 'Become Manager',
        startTime,
        error,
        client,
        logger,
      });
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

        refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'manager promotion' });

        logger.info('User promoted to manager via password', {
          workspaceId,
          userId,
        });

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

      await logManagementModalError({
        userId: body.user.id,
        callbackId: 'manager_promotion_modal',
        message: 'Manager promotion error',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
