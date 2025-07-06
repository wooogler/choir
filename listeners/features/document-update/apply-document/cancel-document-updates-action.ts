import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { deleteProgressMessageTimestamp, getLastMessageTimestamp, getProgressMessageTimestamp } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

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

    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const { originalChannelId, originalThreadTs, index, isFirstSuggestion } = parsedValue;

    // 메시지 텍스트 결정
    const isFirstCancel = isFirstSuggestion || index === 0;
    const cancelText = isFirstCancel ? '❌ Cancelled' : '✅ Completed';

    const cancelMessage = isFirstCancel
      ? 'The document update process has been cancelled.'
      : 'Document update process completed.';

    // DM 채널 열기
    const dmResult = await client.conversations.open({
      users: userId,
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error('DM 채널을 열 수 없습니다');
    }

    const dmChannelId = dmResult.channel.id;

    // 진행 중 메시지가 있다면 삭제
    const progressTs = getProgressMessageTimestamp(userId);
    if (progressTs) {
      try {
        await client.chat.delete({
          channel: dmChannelId,
          ts: progressTs,
        });
        deleteProgressMessageTimestamp(userId);
        logger.info('Progress message deleted successfully');
      } catch (deleteError) {
        logger.warn('진행 중 메시지 삭제 실패 (메시지가 이미 없을 수 있음):', deleteError);
      }
    }

    // 마지막 suggestion 메시지를 "cancelled" 메시지로 업데이트
    const lastMessageTs = getLastMessageTimestamp(userId);
    if (lastMessageTs) {
      try {
        await client.chat.update({
          channel: dmChannelId,
          ts: lastMessageTs,
          text: cancelMessage,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${cancelText} ${cancelMessage}`,
              },
            },
          ],
        });
        logger.info('Last message updated successfully with cancellation');
      } catch (updateError) {
        logger.warn('마지막 메시지 업데이트 실패, 새 메시지로 대체:', updateError);
        // 업데이트 실패 시 새 메시지 전송
        try {
          await client.chat.postMessage({
            channel: dmChannelId,
            text: cancelMessage,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `${cancelText} ${cancelMessage}`,
                },
              },
            ],
          });
        } catch (postError) {
          logger.error('새 취소 메시지 전송도 실패:', postError);
        }
      }
    } else {
      // lastMessageTs가 없는 경우 새 메시지 전송
      try {
        await client.chat.postMessage({
          channel: dmChannelId,
          text: cancelMessage,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${cancelText} ${cancelMessage}`,
              },
            },
          ],
        });
        logger.info('New cancellation message sent');
      } catch (postError) {
        logger.error('새 취소 메시지 전송 실패:', postError);
      }
    }

    // 로그: 문서 업데이트 취소
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        userId,
        workspaceId,
        dmChannelId,
        'dm',
        'cancel_document_updates',
        Date.now() - startTime,
        true,
        {
          isFirstCancel,
          originalChannelId,
          originalThreadTs,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log button click error:', logError);
    }

    // 원본 채널에 취소 알림 (옵션)
    if (originalChannelId) {
      try {
        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: `📋 ${cancelMessage}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📋 ${cancelMessage}`,
              },
            },
          ],
        });
      } catch (error) {
        logger.error('Failed to send cancellation notification to original channel:', error);
      }
    }

    logger.info(`Document update ${isFirstCancel ? 'cancelled' : 'completed'} by user ${userId}`);
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
            },
          ],
        });
      }
    } catch (dmError) {
      logger.error('Failed to send error message:', dmError);
    }
  }
};
