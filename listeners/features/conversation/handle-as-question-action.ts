import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';
import { handleQuestionMessage } from '../qa/question-handler';

/**
 * Handle "This was a question" button click
 */
export const handleAsQuestionCallback = async ({
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
      throw new Error('Action value is missing');
    }

    const messageData = JSON.parse(actionValue);

    // 원본 이벤트 객체 재구성
    const reconstructedEvent = {
      user: messageData.userId,
      channel: messageData.channelId,
      ts: messageData.threadTs,
      channel_type: messageData.channelType,
    };

    // 원본 메시지를 question으로 처리
    await handleQuestionMessage(client, reconstructedEvent, messageData.originalMessage, logger);

    // 원본 메시지 업데이트 (버튼 제거)
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;

    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: "✅ Got it! I've processed your message as a question.",
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "✅ Got it! I've processed your message as a question.",
            },
          },
        ],
      });
    }

    logger.info(`Message re-processed as question for user ${messageData.userId}`);

    // 로그: 성공
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || 'dm',
      'dm',
      'handle_as_question',
      Date.now() - startTime,
      true,
      {
        originalUserId: messageData.userId,
        originalChannelId: messageData.channelId,
        originalThreadTs: messageData.threadTs,
        originalChannelType: messageData.channelType,
        originalMessage: messageData.originalMessage,
        originalMessageLength: messageData.originalMessage?.length || 0,
        messageUpdated: !!(channelId && messageTs),
      },
      client,
    );
  } catch (error) {
    logger.error('Error handling message as question:', error);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to process your message as a question: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'dm',
        'dm',
        'handle_as_question',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          actionValue: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging handle_as_question failure:', logError);
    }
  }
};
