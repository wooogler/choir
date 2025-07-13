import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

/**
 * Manager가 "No Thanks" 버튼을 클릭했을 때 처리
 */
export const dismissManagerUpdateCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const actionValue = body.actions[0].value;
    if (!actionValue) {
      logger.error('No action value provided for dismiss_manager_update');
      return;
    }
    const { channelId, messageTs } = JSON.parse(actionValue);

    // 버튼들을 제거하고 완료 메시지로 업데이트
    const currentMessageTs = (body.message as any)?.ts;
    if (currentMessageTs) {
      await client.chat.update({
        channel: channelId,
        ts: currentMessageTs,
        text: 'Reply sent successfully!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '✅ *Reply successfully sent to the anonymous questioner!*\nIf you need help with documentation updates in the future, just mention me.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          },
        ],
      });
    }

    logger.info(`Manager dismissed update suggestion for message ${messageTs}`);

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      channelId,
      'dm',
      'dismiss_manager_update',
      Date.now() - startTime,
      true,
      {
        channelId,
        messageTs,
      },
      client,
    );
  } catch (error) {
    logger.error('Error dismissing manager update:', error);

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'dm',
        'dismiss_manager_update',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          actionValue: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};