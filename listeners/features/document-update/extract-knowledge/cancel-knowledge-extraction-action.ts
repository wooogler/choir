import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

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

  // response_url을 통해 ephemeral 메시지를 "취소됨" 상태로 업데이트 - DISABLED
  // try {
  //   if (body.response_url) {
  //     await fetch(body.response_url, {
  //       method: 'POST',
  //       headers: {
  //         'Content-Type': 'application/json',
  //       },
  //       body: JSON.stringify({
  //         replace_original: true,
  //         text: '❌ Knowledge extraction cancelled',
  //         blocks: [
  //           {
  //             type: 'section',
  //             text: {
  //               type: 'mrkdwn',
  //               text: '❌ *Knowledge extraction cancelled*\nThe suggested update has been discarded.',
  //             },
  //           },
  //         ],
  //       }),
  //     });
  //   }
  // } catch (error) {
  //   logger.warn('Failed to update ephemeral message via response_url:', error);
  // }

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

    // Determine if this is a user cancellation (ephemeral message) or manager decline (DM message)
    const channelId = body.container?.channel_id || userId;
    const messageTs = body.container?.message_ts;
    const isUserCancellation = userId === (sessionData as any).userId; // User cancelling their own request
    
    logger.info(`Attempting to cancel knowledge extraction - Channel: ${channelId}, Message TS: ${messageTs}, User cancellation: ${isUserCancellation}`);

    // Handle manager DM message update (for manager decline)
    if (!isUserCancellation && messageTs) {
      try {
        const currentMessage = await client.conversations.history({
          channel: channelId,
          latest: messageTs,
          inclusive: true,
          limit: 1,
        });

        if (currentMessage.messages && currentMessage.messages.length > 0) {
          const message = currentMessage.messages[0];
          
          // Remove action blocks (buttons) but keep all other content
          const blocksWithoutActions = message.blocks ? message.blocks.filter((block: any) => {
            return block.type !== 'actions';
          }) : [];

          // Add a declined status section
          const declinedBlock = {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: '❌ *Declined by manager* - No further action will be taken.',
            },
          };

          // Update the message with buttons removed and declined status added
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: message.text || 'Document Update Suggestion',
            blocks: [...blocksWithoutActions, declinedBlock] as any,
          });
          
          logger.info(`Successfully updated manager message to show declined status`);
        }
      } catch (messageError) {
        logger.warn('Failed to update manager message:', messageError);
      }
    }

    // Send notification to the original channel
    if (originalChannelId && originalChannelId !== 'unknown') {
      try {
        const sessionDataTyped = sessionData as any;
        const userName = sessionDataTyped.userName || 'A team member';
        
        let notificationText, notificationBlocks;
        
        if (isUserCancellation) {
          // User cancelled their own request
          notificationText = '❌ Update suggestion cancelled';
          notificationBlocks = [
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: '❌ The update suggestion has been *cancelled*.',
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
            },
          ];
        } else {
          // Manager declined the request
          notificationText = '❌ Update suggestion declined by manager';
          notificationBlocks = [
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: `❌ *${userName}*, your document update suggestion was *declined by a manager*. No changes will be made to the documentation at this time.`,
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
            },
          ];
        }
        
        logger.info(`Sending ${isUserCancellation ? 'cancellation' : 'decline'} notification to channel: ${originalChannelId}`);
        
        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: notificationText,
          blocks: notificationBlocks,
          unfurl_links: false,
          unfurl_media: false,
        });
        
        logger.info(`Successfully sent notification to ${originalChannelId}`);
      } catch (notificationError) {
        logger.warn('Failed to send notification:', notificationError);
      }
    } else {
      logger.warn(`Cannot send notification - invalid channel ID: ${originalChannelId}`);
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
