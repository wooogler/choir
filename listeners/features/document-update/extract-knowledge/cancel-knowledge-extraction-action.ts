import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getManagers, getUserName, getWorkspaceId } from 'services/slack';
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

  //response_url을 통해 ephemeral 메시지를 "취소됨" 상태로 업데이트
  try {
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: '✅ Got it!',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '✅ *Processing your decision...*',
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

    // Determine if this is a user cancellation (ephemeral message) or manager decline (DM message)
    const channelId = body.container?.channel_id || userId;
    const messageTs = body.container?.message_ts;
    const isUserCancellation = userId === (sessionData as any).userId; // User cancelling their own request

    logger.info(
      `Attempting to cancel knowledge extraction - Channel: ${channelId}, Message TS: ${messageTs}, User cancellation: ${isUserCancellation}`,
    );

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
          const blocksWithoutActions = message.blocks
            ? message.blocks.filter((block: any) => {
                return block.type !== 'actions';
              })
            : [];

          // Get manager name for declined status
          let managerName = 'manager';
          try {
            const managerUserInfo = await getUserName(userId, client);
            managerName = managerUserInfo;
          } catch (error) {
            logger.warn('Failed to get manager name for DM decline status:', error);
          }

          // Add a declined status section
          const declinedBlock = {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: `❌ *Declined by ${managerName}* - No further action will be taken.`,
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
          // Manager declined the request - get manager name
          let managerName = 'A manager';
          try {
            const managerUserInfo = await getUserName(userId, client);
            managerName = managerUserInfo;
          } catch (error) {
            logger.warn('Failed to get manager name for decline notification:', error);
          }

          notificationText = `❌ Update suggestion declined by ${managerName}`;
          notificationBlocks = [
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: `❌ *${userName}*, your document update suggestion was *declined by ${managerName}*. No changes will be made to the documentation at this time.`,
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
            },
          ];
        }

        logger.info(
          `Sending ${isUserCancellation ? 'cancellation' : 'decline'} notification to channel: ${originalChannelId}`,
        );

        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: notificationText,
          blocks: notificationBlocks,
          unfurl_links: false,
          unfurl_media: false,
        });

        logger.info(`Successfully sent notification to ${originalChannelId}`);

        // If this is a manager decline (not user cancellation), notify other managers
        if (!isUserCancellation) {
          await notifyOtherManagersAboutDecline(userId, sessionData, client, logger);
        }
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
      const sessionId = body.actions?.[0]?.value;
      let originalChannelId = body.channel?.id || 'unknown';
      let originalThreadTs = undefined;

      // Try to get original channel and thread info from session data for proper targeting
      if (sessionId) {
        try {
          const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE);
          if (sessionData) {
            const typedSessionData = sessionData as any;
            originalChannelId = typedSessionData.originalChannelId || originalChannelId;
            originalThreadTs = typedSessionData.originalThreadTs;
          }
        } catch (sessionError) {
          logger.warn('Could not get session data for error message targeting:', sessionError);
        }
      }

      const ephemeralParams: any = {
        channel: originalChannelId,
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
      };

      // Only add thread_ts if we're in a thread
      if (originalThreadTs) {
        ephemeralParams.thread_ts = originalThreadTs;
      }

      await client.chat.postEphemeral(ephemeralParams);
    } catch (ephemeralError) {
      logger.error('Failed to send error ephemeral message:', ephemeralError);
    }
  }
};

/**
 * Notify other managers that one manager declined the suggestion
 */
async function notifyOtherManagersAboutDecline(
  decliningManagerId: string,
  sessionData: any,
  client: any,
  logger: any,
): Promise<void> {
  try {
    // Get workspace ID and managers list
    const workspaceId = await getWorkspaceId(client);
    const managers = await getManagers(workspaceId);

    // Filter out the declining manager
    const otherManagers = managers.filter((managerId) => managerId !== decliningManagerId);

    if (otherManagers.length === 0) {
      logger.info('No other managers to notify about decline');
      return;
    }

    // Get declining manager name
    const decliningManagerName = await getUserName(decliningManagerId, client);
    const userName = sessionData.userName || 'A team member';

    // Send decline notification to each other manager via DM
    const notificationPromises = otherManagers.map(async (managerId) => {
      try {
        const simpleMessage = `${decliningManagerName} declined the document update suggestion from *${userName}*. You can still review this suggestion if you think it has merit.`;

        await client.chat.postMessage({
          channel: managerId, // DM to manager
          text: simpleMessage,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: simpleMessage,
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
            },
          ],
          unfurl_links: false,
          unfurl_media: false,
        });
        logger.info(`Notified manager ${managerId} about decline by ${decliningManagerName}`);
      } catch (error) {
        logger.warn(`Failed to notify manager ${managerId} about decline:`, error);
      }
    });

    await Promise.allSettled(notificationPromises);
    logger.info(`Decline notification sent to ${otherManagers.length} other managers`);
  } catch (error) {
    logger.error('Error notifying other managers about decline:', error);
  }
}
