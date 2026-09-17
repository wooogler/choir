import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { clearRegistrationRequest, getCHOIRUsers, getWorkspaceId, setCHOIRUsers } from 'services/slack';
import { logManagementButtonError, refreshAppHomeSoon, requireManagerForAction } from './shared';

export const registerChoirUsersHandlers = (app: App) => {
  app.action('manage_choir_users', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const t = tForRequest(context);

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) {
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
            text: t('appHome.management.choirUsers.title'),
          },
          submit: {
            type: 'plain_text',
            text: t('appHome.management.choirUsers.submit'),
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
                text: t('appHome.management.choirUsers.intro'),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.choirUsers.status', { count: choirUsers.length }),
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
                  text: t('appHome.management.choirUsers.placeholder'),
                },
              },
              label: {
                type: 'plain_text',
                text: t('appHome.management.choirUsers.label'),
              },
              hint: {
                type: 'plain_text',
                text: t('appHome.management.choirUsers.hint'),
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: t('appHome.management.choirUsers.privacy'),
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
          text: t('appHome.management.choirUsers.error.open'),
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

  app.view('choir_users_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const t = tForRequest(context);
    let acked = false;

    // Only cheap checks run before ack. setCHOIRUsers below resolves each selected
    // user's name (a users.info call per user on a cold cache), which for a large
    // roster can exceed Slack's ~3s ack deadline — so ack first and do that work
    // after, reporting the outcome via an ephemeral message instead of the modal.
    try {
      if (!(await requireManagerForAction({ client, userId, t }))) {
        await ack();
        acked = true;
        return;
      }

      const selectedUsers = view.state.values.choir_users_select_block.choir_users_select.selected_users || [];

      if (selectedUsers.length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            choir_users_select_block: t('appHome.management.choirUsers.error.empty'),
          },
        });
        acked = true;
        return;
      }

      await ack();
      acked = true;

      const workspaceId = await getWorkspaceId(client);
      const success = await setCHOIRUsers(workspaceId, selectedUsers, client);

      if (success) {
        // A manual roster change supersedes any self-service access request for
        // these users (idempotent no-op when none is pending).
        for (const id of selectedUsers) {
          clearRegistrationRequest(workspaceId, id);
        }

        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.management.choirUsers.updated', { count: selectedUsers.length }),
        });

        refreshAppHomeSoon({ client, logger, userId, reason: 'CHOIR users update' });

        logger.info('CHOIR users updated via modal', {
          workspaceId,
          userId,
          userCount: selectedUsers.length,
        });

        await logAppHomeModalSubmit(
          userId,
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
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.management.choirUsers.error.save'),
        });

        await logAppHomeModalSubmit(
          userId,
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
      if (!acked) {
        // Pre-ack failure: the modal is still open, so surface it there.
        await ack({
          response_action: 'errors',
          errors: {
            choir_users_select_block: t('appHome.management.choirUsers.error.generic'),
          },
        }).catch((ackError) => logger.error('Failed to ack CHOIR users modal error:', ackError));
      } else {
        // Modal already closed; notify via ephemeral so the error isn't swallowed.
        await client.chat
          .postEphemeral({
            user: userId,
            channel: userId,
            text: t('appHome.management.choirUsers.error.postAck'),
          })
          .catch((dmError) => logger.error('Failed to notify CHOIR users update error:', dmError));
      }
    }
  });
};
