import type {
  AllMiddlewareArgs,
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
  UsersSelectAction,
} from '@slack/bolt';
import { addManager, getWorkspaceId, isWorkspaceOwner, removeManager, setupInitialManager } from 'services/slack';

// Store user selection state
const selectedUsers = new Map<string, string>();

/**
 * Handle user selection action
 */
const selectUserCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    // UsersSelect action from value
    const action = body.actions[0] as UsersSelectAction;
    const selectedUser = action.selected_user;

    // No user selected
    if (!selectedUser) {
      logger.error('No user selected in user select action');
      return;
    }

    // Store selected user
    selectedUsers.set(userId, selectedUser);

    logger.info(`User ${userId} selected ${selectedUser} for permission management`);
  } catch (error) {
    logger.error('Error handling user selection:', error);
  }
};

/**
 * Grant manager permission action
 */
const addManagerCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // If user is workspace owner, set as initial manager
    const isOwner = await isWorkspaceOwner(userId, client);
    if (isOwner) {
      setupInitialManager(workspaceId, userId, client);
    }

    // Confirm selected user
    const selectedUser = selectedUsers.get(userId);
    if (!selectedUser) {
      // If no user is selected, send error message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: 'Please select a user to grant permission first.',
      });
      return;
    }

    // Try to grant permission
    const success = await addManager(workspaceId, selectedUser, userId);

    if (success) {
      // Send success message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: `✅ Manager permission has been granted to <@${selectedUser}>.`,
      });

      // Auto-refresh home screen
      setTimeout(async () => {
        try {
          const { appHomeOpenedCallback } = await import('../../event-handlers/app-home-handler');

          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
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
          logger.info(`Home screen refreshed for user ${userId} after adding manager permission`);
        } catch (error) {
          logger.error('Error refreshing home view after adding manager:', error);
        }
      }, 1000);

      // Send notification message
      try {
        await client.chat.postMessage({
          channel: selectedUser,
          text: `<@${userId}> has granted you CHOIR manager permission.`,
        });
      } catch (error) {
        logger.error(`Failed to send notification to user ${selectedUser}:`, error);
      }
    } else {
      // Send failure message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: 'Failed to grant permission. Please check if you have manager permission.',
      });
    }
  } catch (error) {
    logger.error('Error adding manager permission:', error);
  }
};

/**
 * Remove manager permission action
 */
const removeManagerCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // If user is workspace owner, set as initial manager
    const isOwner = await isWorkspaceOwner(userId, client);
    if (isOwner) {
      setupInitialManager(workspaceId, userId, client);
    }

    // Confirm selected user - Button action from value
    const action = body.actions[0] as ButtonAction;
    const targetUserId = action.value;

    // No value
    if (!targetUserId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: 'Unable to identify target user. Please try again.',
      });
      return;
    }

    // Cannot remove own permission
    if (targetUserId === userId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: 'You cannot remove your own manager permission.',
      });
      return;
    }

    // Try to remove permission
    const success = await removeManager(workspaceId, targetUserId, userId);

    if (success) {
      // Send success message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: `✅ Manager permission has been removed from <@${targetUserId}>.`,
      });

      // Auto-refresh home screen
      setTimeout(async () => {
        try {
          const { appHomeOpenedCallback } = await import('../../event-handlers/app-home-handler');

          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
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
          logger.info(`Home screen refreshed for user ${userId} after removing manager permission`);
        } catch (error) {
          logger.error('Error refreshing home view after removing manager:', error);
        }
      }, 1000);

      // Send notification message
      try {
        await client.chat.postMessage({
          channel: targetUserId,
          text: `<@${userId}> has removed your CHOIR manager permission.`,
        });
      } catch (error) {
        logger.error(`Failed to send notification to user ${targetUserId}:`, error);
      }
    } else {
      // Send failure message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: 'Failed to remove permission. Please check if you have manager permission.',
      });
    }
  } catch (error) {
    logger.error('Error removing manager permission:', error);
  }
};

export { selectUserCallback, addManagerCallback, removeManagerCallback };
