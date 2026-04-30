import type { App, SlackActionMiddlewareArgs, SlackViewMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getOrganizationName, getWorkspaceId, setOrganizationName } from 'services/slack';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

export const registerOrganizationHandlers = (app: App) => {
  app.action('edit_organization_name', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const organizationName = (await getOrganizationName(workspaceId)) || 'Our Organization';

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'edit_organization_name_modal',
          notify_on_close: true,
          title: {
            type: 'plain_text',
            text: 'Edit Organization Name',
          },
          submit: {
            type: 'plain_text',
            text: 'Save Changes',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
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
                text: 'Organization Name',
              },
            },
          ],
        },
      });

      // Log success
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'edit_organization_name',
        Date.now() - startTime,
        true,
        'Edit Organization Name',
        {
          currentName: organizationName,
        },
        client,
      );
    } catch (error) {
      logger.error('Error opening organization edit modal:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error opening edit modal. Please try again.',
      });

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeButtonClick(
          body.user.id,
          workspaceId,
          'edit_organization_name',
          Date.now() - startTime,
          false,
          'Edit Organization Name',
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

  app.view('edit_organization_name_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      const newName = view.state.values.organization_name_input_block.organization_name_input.value;

      if (!newName || newName.trim().length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            organization_name_input_block: 'Organization name is required.',
          },
        });

        // Log validation error
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'edit_organization_name_modal',
          Date.now() - startTime,
          false,
          'Organization name modal submitted with empty name',
          {
            error: 'Empty organization name',
          },
          client,
        );
        return;
      }

      await ack();

      const workspaceId = await getWorkspaceId(client);

      await setOrganizationName(workspaceId, newName.trim());

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: `✅ Organization name updated to "${newName.trim()}"!`,
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
          logger.info(`Home screen refreshed for user ${body.user.id} after organization name update`);
        } catch (error) {
          logger.error('Error refreshing home view after organization name update:', error);
        }
      }, 1000);

      // Log successful update
      await logAppHomeModalSubmit(
        body.user.id,
        workspaceId,
        'edit_organization_name_modal',
        Date.now() - startTime,
        true,
        `Organization name updated to: "${newName.trim()}"`,
        {
          submittedName: newName.trim(),
          nameLength: newName.trim().length,
        },
        client,
      );
    } catch (error) {
      logger.error('Error updating organization name:', error);
      await ack({
        response_action: 'errors',
        errors: {
          organization_name_input_block: 'An error occurred while updating organization name. Please try again.',
        },
      });

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'edit_organization_name_modal',
          Date.now() - startTime,
          false,
          'Organization name update error',
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
