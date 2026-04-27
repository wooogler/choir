import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { deleteProgressMessageTimestamp, getLastMessageTimestamp, getProgressMessageTimestamp } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getFileSelectionState } from 'services/document/document-store';
import { getUserName, getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * Handle "Cancel" button click in document update suggestions
 */
export const cancelDocumentUpdatesCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const userId = body.user.id;
    const value = body.actions?.[0]?.value;
    const responseUrl = body.response_url;

    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const { originalChannelId, originalThreadTs, index, isFirstSuggestion } = parsedValue;
    const workspaceId = await getWorkspaceId(client);

    // Apply된 suggestion 수를 확인해서 cancel vs stop 결정
    const fileSelectionState = getFileSelectionState(userId, workspaceId);
    const appliedCount = fileSelectionState?.appliedSuggestions.size || 0;

    // 메시지 텍스트 결정: Apply된 것이 없으면 cancel, 있으면 stop
    const isCancel = appliedCount === 0;

    const cancelMessage = isCancel
      ? '👋 Review cancelled'
      : `✅ Review stopped! We've applied ${appliedCount} suggestion${appliedCount > 1 ? 's' : ''} to the documentation.`;

    const notificationMessage = isCancel
      ? 'cancelled their document update review'
      : `stopped their document update review after applying ${appliedCount} suggestion${appliedCount > 1 ? 's' : ''}`;

    // Use response_url to replace the current message with cancellation status
    if (responseUrl) {
      try {
        const response = await fetch(responseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            replace_original: true,
            text: cancelMessage,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: cancelMessage,
                },
              },
            ],
            unfurl_links: false,
            unfurl_media: false,
          }),
        });

        if (!response.ok) {
          console.error('Failed to send cancellation response:', await response.text());
          throw new Error('Failed to send cancellation via response_url');
        }

        logger.info('Cancellation message sent via response_url successfully');
      } catch (responseError) {
        logger.error('Failed to send cancellation via response_url:', responseError);

        // Fallback to regular postMessage if response_url fails
        const dmResult = await client.conversations.open({
          users: userId,
        });

        if (dmResult.ok && dmResult.channel?.id) {
          await client.chat.postMessage({
            channel: dmResult.channel.id,
            text: cancelMessage,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: cancelMessage,
                },
              },
            ],
          });
        }
      }
    } else {
      // Fallback for cases where response_url is not available
      const dmResult = await client.conversations.open({
        users: userId,
      });

      if (!dmResult.ok || !dmResult.channel?.id) {
        throw new Error('DM 채널을 열 수 없습니다');
      }

      await client.chat.postMessage({
        channel: dmResult.channel.id,
        text: cancelMessage,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: cancelMessage,
            },
          },
        ],
      });
    }

    // Clean up progress message timestamp if exists
    const progressTs = getProgressMessageTimestamp(userId);
    if (progressTs) {
      deleteProgressMessageTimestamp(userId);
      logger.info('Progress message timestamp cleared');
    }

    // 로그: 문서 업데이트 취소
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        userId,
        workspaceId,
        'dm',
        'dm',
        'cancel_document_updates',
        Date.now() - startTime,
        true,
        {
          isCancel,
          appliedCount,
          originalChannelId,
          originalThreadTs,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log button click error:', logError);
    }

    // 원본 채널에 취소 알림 (현재 DM과 다른 채널에서 온 경우)
    const currentDmChannelId = body.channel?.id;
    if (originalChannelId && originalChannelId !== currentDmChannelId) {
      try {
        // Get user name for the notification
        const userName = await getUserName(userId, client);

        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: `📋 *${userName}* ${notificationMessage}.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📋 *${userName}* ${notificationMessage}.`,
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
            },
          ],
        });
      } catch (error) {
        logger.error('Failed to send cancellation notification to original channel:', error);
      }
    }

    logger.info(
      `Document update ${isCancel ? 'cancelled' : 'stopped'} by user ${userId} (applied ${appliedCount} suggestions)`,
    );
  } catch (error) {
    logger.error('Error cancelling document updates:', error);

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        'dm',
        'dm',
        'cancel_document_updates',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log cancel error:', logError);
    }

    // 사용자에게 에러 메시지 전송
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id,
      });

      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `❌ Failed to cancel document updates: ${error instanceof Error ? error.message : 'Unknown error'}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `❌ *Error occurred while cancelling*\n${error instanceof Error ? error.message : 'Unknown error'}`,
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
            },
          ],
        });
      }
    } catch (dmError) {
      logger.error('Failed to send error message:', dmError);
    }
  }
};
