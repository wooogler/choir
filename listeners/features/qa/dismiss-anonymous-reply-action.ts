import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

/**
 * Anonymous reply에서 "No Thanks" 버튼 처리
 */
export const dismissAnonymousReplyCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const sessionId = body.actions[0].value;

    // 버튼들을 제거하고 완료 메시지로 업데이트
    const messageTs = (body.message as any)?.ts;
    const channelId = body.channel?.id;

    if (messageTs && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Thanks for the reply!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '✅ *Thanks for the reply!*\nIf you need help with documentation updates in the future, just mention me.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          },
        ],
      });
    }

    logger.info(`Anonymous reply dismissed for session ${sessionId}`);

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      channelId || body.user.id,
      'dm',
      'dismiss_anonymous_reply',
      Date.now() - startTime,
      true,
      {
        sessionId,
      },
      client,
    );
  } catch (error) {
    logger.error('Error dismissing anonymous reply:', error);

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || body.user.id,
        'dm',
        'dismiss_anonymous_reply',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          sessionId: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};