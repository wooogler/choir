import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

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

    // response_url을 통해 ephemeral 메시지를 "완료됨" 상태로 업데이트
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: 'Reply sent successfully!',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '✅ *Reply successfully sent to the anonymous questioner!*\nIf you need help with documentation updates in the future, just mention me.',
              },
            },
          ],
        }),
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
