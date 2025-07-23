import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

/**
 * Handle "Cancel" button click during knowledge extraction flow
 */
export const cancelKnowledgeExtractionCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // response_url을 통해 ephemeral 메시지를 "취소됨" 상태로 업데이트
  try {
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: '❌ Knowledge extraction cancelled',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '❌ *Knowledge extraction cancelled*\nThe suggested update has been discarded.',
              },
            },
          ],
        }),
      });
    }
  } catch (error) {
    logger.warn('Failed to update ephemeral message via response_url:', error);
  }

  try {
    const userId = body.user.id;
    const sessionId = body.actions?.[0]?.value;

    if (!sessionId) {
      throw new Error('Session ID not found in button value');
    }

    // Get session data to find original channel info
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE);
    if (!sessionData) {
      throw new Error('Session data not found');
    }

    const { originalChannelId, originalThreadTs, publicMessageTs } = sessionData as any;

    // Update the ephemeral message to show cancellation
    try {
      await client.chat.update({
        channel: body.container?.channel_id || originalChannelId,
        ts: body.container?.message_ts || '',
        text: '❌ Knowledge extraction cancelled.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ *Knowledge extraction cancelled*\nThe suggested update process has been stopped.',
            },
          },
        ],
      });
    } catch (updateError) {
      logger.warn('Failed to update ephemeral message, will send new message:', updateError);

      // If update fails, send a new ephemeral message
      await client.chat.postEphemeral({
        channel: originalChannelId,
        ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
        user: userId,
        text: '❌ Knowledge extraction cancelled.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ *Knowledge extraction cancelled*\nThe suggested update process has been stopped.',
            },
          },
        ],
      });
    }

    // Update the public message to show cancellation
    if (publicMessageTs && originalChannelId) {
      try {
        await client.chat.update({
          channel: originalChannelId,
          ts: publicMessageTs,
          text: '❌ Update suggestion cancelled.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '❌ *Update suggestion cancelled*\nThe knowledge extraction process was stopped by the user.',
              },
            },
          ],
        });
      } catch (publicUpdateError) {
        logger.warn('Failed to update public message:', publicUpdateError);
      }
    }

    // Log successful cancellation
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      userId,
      workspaceId,
      originalChannelId || 'unknown',
      originalThreadTs ? 'public' : 'public',
      'cancel_knowledge_extraction',
      Date.now() - startTime,
      true,
      {
        sessionId,
        originalChannelId,
        originalThreadTs,
      },
      client,
    );

    logger.info(`Knowledge extraction cancelled by user ${userId} for session ${sessionId}`);
  } catch (error) {
    logger.error('Error cancelling knowledge extraction:', error);

    // Log error
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        'unknown',
        'public',
        'cancel_knowledge_extraction',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log cancellation error:', logError);
    }

    // Send error message to user
    try {
      await client.chat.postEphemeral({
        channel: body.channel?.id || 'unknown',
        user: body.user.id,
        text: `❌ Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *Error occurred while cancelling*\n${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          },
        ],
      });
    } catch (ephemeralError) {
      logger.error('Failed to send error ephemeral message:', ephemeralError);
    }
  }
};
