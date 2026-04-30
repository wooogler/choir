import type { AllMiddlewareArgs, App, SlackViewMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick, logButtonClick } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';

/**
 * App Home Modal cancel/close 처리 콜백
 */
const appHomeModalCloseCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();
  const startTime = Date.now();

  const callbackId = view?.callback_id || 'unknown';
  const userId = body.user?.id || 'unknown';
  const isCleared = (body as any).is_cleared || false;

  logger.info('App Home modal close event received', {
    callbackId,
    userId,
    isCleared,
  });

  try {
    const workspaceId = await getWorkspaceId(client);

    // Log the app home modal cancellation
    await logAppHomeButtonClick(
      userId,
      workspaceId,
      `${callbackId}_cancel`,
      Date.now() - startTime,
      true,
      'Cancel',
      {
        modalCancelled: callbackId,
        cancelReason: isCleared ? 'cleared' : 'user_cancelled',
      },
      client,
    );

    logger.info(`App Home modal cancelled: ${callbackId}`, { userId });
  } catch (error) {
    logger.error('Error processing app home modal close:', error);

    try {
      const workspaceId = await getWorkspaceId(client);
      await logAppHomeButtonClick(
        userId,
        workspaceId,
        'modal_cancel_error',
        Date.now() - startTime,
        false,
        'Cancel',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          callbackId,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log app home modal close error:', logError);
    }
  }
};

/**
 * Modal cancel/close 처리 콜백
 */
const modalCloseCallback = async ({ ack, body, view, client, logger }: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();
  const startTime = Date.now();

  // view_closed payload structure
  const callbackId = view?.callback_id || 'unknown';
  const userId = body.user?.id || 'unknown';
  const isCleared = (body as any).is_cleared || false;

  // Debug logging
  logger.info('Modal close event received', {
    callbackId,
    userId,
    eventStructure: {
      hasView: !!view,
      hasUser: !!body.user,
      privateMetadata: view?.private_metadata,
      isCleared,
    },
  });

  try {
    const privateMetadata = view?.private_metadata;

    // Parse session ID and channel info from private metadata if it exists
    let sessionId: string | undefined;
    let originalChannelId = 'modal';
    let originalChannelType: 'public' | 'private' | 'dm' = 'dm';

    try {
      if (privateMetadata) {
        // Try parsing as JSON first (for most modals)
        const parsed = JSON.parse(privateMetadata);
        sessionId = parsed.sessionId || parsed;

        // If it has channelId directly in metadata (like suggestion editor)
        if (parsed.channelId) {
          originalChannelId = parsed.channelId;
        }
      }
    } catch {
      // If not JSON, treat as plain string (sessionId directly)
      sessionId = privateMetadata;
    }

    // Try to get channel info from session data if we have sessionId
    if (sessionId && sessionId !== 'modal') {
      try {
        const { getSessionData } = await import('services/common');
        const { SessionType } = await import('services/common');
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        if (sessionData?.originalChannelId) {
          originalChannelId = sessionData.originalChannelId;
        }
      } catch (sessionError) {
        logger.warn('Could not get session data for modal close logging:', sessionError);
      }
    }

    // Determine channel type if we have a real channel ID
    if (originalChannelId !== 'modal') {
      try {
        const channelInfo = await client.conversations.info({ channel: originalChannelId });
        if (channelInfo.channel?.is_private) {
          originalChannelType = 'private';
        } else if (channelInfo.channel?.is_im) {
          originalChannelType = 'dm';
        } else {
          originalChannelType = 'public';
        }
      } catch (channelInfoError) {
        logger.warn('Could not get channel info for modal close logging:', channelInfoError);
      }
    }

    // Get workspace ID for logging
    const workspaceId = await getWorkspaceId(client);

    // Log the modal cancellation
    await logButtonClick(
      userId,
      workspaceId,
      originalChannelId,
      originalChannelType,
      `${callbackId}_cancel`,
      Date.now() - startTime,
      true,
      {
        modalCancelled: callbackId,
        sessionId,
        cancelReason: isCleared ? 'cleared' : 'user_cancelled',
        originalChannelId,
        originalChannelType,
      },
      client,
    );

    logger.info(`Modal cancelled: ${callbackId}`, { userId, sessionId });
  } catch (error) {
    logger.error('Error processing modal close:', error);

    // Try to log the error
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        userId,
        workspaceId,
        'modal',
        'dm',
        'modal_cancel_error',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          callbackId,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log modal close error:', logError);
    }
  }
};

const register = (app: App) => {
  // Handle view_closed for Q&A modals
  app.view({ callback_id: 'ask_to_channel_submit', type: 'view_closed' }, modalCloseCallback);
  app.view({ callback_id: 'ask_to_others_submit', type: 'view_closed' }, modalCloseCallback);

  // Handle view_closed for knowledge edit modals
  app.view({ callback_id: 'knowledge_edit_modal', type: 'view_closed' }, modalCloseCallback);
  app.view({ callback_id: 'knowledge_edit_manager_modal', type: 'view_closed' }, modalCloseCallback);

  // Handle view_closed for update editor modal
  app.view({ callback_id: 'update_editor_submission', type: 'view_closed' }, modalCloseCallback);

  // Handle view_closed for new section modal
  app.view({ callback_id: 'new_section_modal', type: 'view_closed' }, modalCloseCallback);

  // Handle view_closed for create file modal
  app.view({ callback_id: 'create_file_modal', type: 'view_closed' }, modalCloseCallback);

  // Handle view_closed for App Home modals
  app.view({ callback_id: 'manager_promotion_modal', type: 'view_closed' }, appHomeModalCloseCallback);
  app.view({ callback_id: 'choir_users_modal', type: 'view_closed' }, appHomeModalCloseCallback);
  app.view({ callback_id: 'managers_modal', type: 'view_closed' }, appHomeModalCloseCallback);
  app.view({ callback_id: 'readonly_files_modal', type: 'view_closed' }, appHomeModalCloseCallback);
  app.view({ callback_id: 'select_repository_modal', type: 'view_closed' }, appHomeModalCloseCallback);
  app.view({ callback_id: 'github_device_code_modal', type: 'view_closed' }, appHomeModalCloseCallback);
  app.view({ callback_id: 'edit_organization_name_modal', type: 'view_closed' }, appHomeModalCloseCallback);
};

export default { register };
