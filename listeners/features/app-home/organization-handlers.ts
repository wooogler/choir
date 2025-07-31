import type { App, SlackActionMiddlewareArgs, SlackViewMiddlewareArgs } from '@slack/bolt';
import { logButtonClick, logModalSubmit } from 'services/common/user-interaction-logger';
import {
  getOrganizationDescription,
  getOrganizationName,
  getWorkspaceId,
  setOrganizationDescription,
  setOrganizationName,
} from 'services/slack';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

export const registerOrganizationHandlers = (app: App) => {
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

  app.action('edit_organization_info', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const organizationName = (await getOrganizationName(workspaceId)) || 'Our Organization';
      const organizationDescription = (await getOrganizationDescription(workspaceId)) || 'No description set.';

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'edit_organization_modal',
          title: {
            type: 'plain_text',
            text: 'Edit Organization Info',
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
                text: 'Organization Description',
              },
            },
          ],
        },
      });

      // Log success
      await logButtonClick(
        body.user.id,
        workspaceId,
        'app_home',
        'dm',
        'edit_organization_info',
        Date.now() - startTime,
        true,
        {
          currentName: organizationName,
          currentDescription: organizationDescription,
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
        await logButtonClick(
          body.user.id,
          workspaceId,
          'app_home',
          'dm',
          'edit_organization_info',
          Date.now() - startTime,
          false,
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

  app.view('edit_organization_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      const newName = view.state.values.organization_name_input_block.organization_name_input.value;
      const newDescription =
        view.state.values.organization_description_input_block.organization_description_input.value;

      if (!newName || newName.trim().length === 0) {
        await ack({
          response_action: 'errors',
          errors: {
            organization_name_input_block: 'Organization name is required.',
          },
        });
        return;
      }

      await ack();

      const workspaceId = await getWorkspaceId(client);

      await setOrganizationName(workspaceId, newName.trim());
      await setOrganizationDescription(workspaceId, newDescription?.trim() || '');

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '✅ Organization information updated successfully!',
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
          logger.info(`Home screen refreshed for user ${body.user.id} after organization info update`);
        } catch (error) {
          logger.error('Error refreshing home view after organization info update:', error);
        }
      }, 1000);

      // Log successful update
      await logModalSubmit(
        body.user.id,
        workspaceId,
        'edit_organization_modal',
        Date.now() - startTime,
        true,
        {
          nameLength: newName.trim().length,
          descriptionLength: newDescription?.trim().length || 0,
          submittedName: newName.trim(),
          submittedDescription: newDescription?.trim() || '',
        },
        client,
        'app_home',
        'dm',
      );
    } catch (error) {
      logger.error('Error updating organization info:', error);
      await ack({
        response_action: 'errors',
        errors: {
          organization_name_input_block: 'An error occurred while updating organization info. Please try again.',
        },
      });

      // Log error
      try {
        const workspaceId = await getWorkspaceId(client);
        await logModalSubmit(
          body.user.id,
          workspaceId,
          'edit_organization_modal',
          Date.now() - startTime,
          false,
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            errorStack: error instanceof Error ? error.stack : undefined,
          },
          client,
          'app_home',
          'dm',
        );
      } catch (logError) {
        logger.error('Failed to log error:', logError);
      }
    }
  });
};
