import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { SessionType, getSessionData } from 'services/common/session-store';
import { getUserName, getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { handleUpdateRequestMessage } from '../document-update/extract-knowledge/update-request-handler';

/**
 * Handle "This was an update request" button click
 */
export const handleAsUpdateRequestCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const sessionId = body.actions[0].value;
    if (!sessionId) {
      throw new Error('Session ID is missing');
    }

    const messageData = getSessionData(sessionId, SessionType.GENERAL_CONVERSATION);
    if (!messageData) {
      throw new Error('Session data not found or expired');
    }

    // Get user name for the message
    const userName = await getUserName(messageData.userId, client);

    // 원본 이벤트 객체 재구성
    const reconstructedEvent = {
      user: messageData.userId,
      channel: messageData.channelId,
      ts: messageData.messageTs,
      thread_ts: messageData.threadTs,
      channel_type: messageData.channelType,
      originalMessage: messageData.originalMessage, // 원본 메시지 텍스트 추가
    };

    // Send friendly public notification first
    await client.chat.postMessage({
      channel: messageData.channelId,
      text: `📝 *${userName}* clarified this was a suggestion for updating our docs - I'll work on that now!`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📝 *${userName}* clarified this was a suggestion for updating our docs - I'll work on that now!`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });

    // response_url을 통해 ephemeral 메시지를 "처리됨" 상태로 업데이트
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: '✅ Processed as Update Request',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *Message processed as Update Request*\n\n📝 *Original message:* "${messageData.originalMessage}"\n🔄 *Action taken:* Extracting knowledge and generating document updates`,
              },
            },
          ],
        }),
      });
    }

    // 원본 메시지를 update request로 처리 (버튼에서 호출된 것으로 표시)
    await handleUpdateRequestMessage(client, reconstructedEvent, logger, true);

    logger.info(`Message re-processed as update request for user ${messageData.userId}`);

    // 로그: 성공
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || 'dm',
      'dm',
      'handle_as_update_request',
      Date.now() - startTime,
      true,
      {
        originalUserId: messageData.userId,
        originalChannelId: messageData.channelId,
        originalThreadTs: messageData.threadTs,
        originalChannelType: messageData.channelType,
        originalMessageLength: messageData.originalMessage?.length || 0,
        messageUpdated: !!body.response_url,
      },
      client,
    );
  } catch (error) {
    logger.error('Error handling message as update request:', error);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to process your message as an update request: ${error instanceof Error ? error.message : 'Unknown error'}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ Failed to process your message as an update request: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'dm',
        'dm',
        'handle_as_update_request',
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
      logger.error('Error logging handle_as_update_request failure:', logError);
    }
  }
};
