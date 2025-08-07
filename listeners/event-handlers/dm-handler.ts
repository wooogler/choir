import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getManagers, getNonUserResponseMessage, getWorkspaceId, isCHOIRUser } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { handleIncomingMessage } from './message-router';

/**
 * DM 메시지 처리 콜백
 */
const dmMessageCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'message'>) => {
  try {
    // DM 메시지인 경우에만 처리 (개별 DM은 모든 경우, 그룹 DM은 thread만)
    if (event.channel_type === 'im') {
      // 개별 DM: 모든 메시지 처리
    } else if (event.channel_type === 'mpim' && 'thread_ts' in event && event.thread_ts) {
      // 그룹 DM: thread 메시지만 처리 (익명 질문 reply 전달용)
    } else {
      return;
    }

    // 봇 메시지 필터링 - 무한 루프 방지
    if (('bot_id' in event && event.bot_id) || event.subtype === 'bot_message') {
      logger.info('Skipping bot message in DM to prevent infinite loop', {
        channel: event.channel,
        botId: 'bot_id' in event ? event.bot_id : undefined,
        subtype: event.subtype,
      });
      return;
    }

    // 추가 안전장치: 자신의 메시지인지 확인
    try {
      const botInfo = await client.auth.test();
      if ('user' in event && event.user === botInfo.user_id) {
        logger.info('Skipping own message in DM to prevent infinite loop', {
          channel: event.channel,
          userId: 'user' in event ? event.user : undefined,
        });
        return;
      }
    } catch (authError) {
      logger.warn('Could not verify bot user ID for message filtering:', authError);
    }

    // Get workspace and check if user is a CHOIR user
    const workspaceId = await getWorkspaceId(client);
    const userId = 'user' in event ? event.user : '';
    if (!userId) return;

    const isUserCHOIRUser = await isCHOIRUser(workspaceId, userId);

    // If user is not a CHOIR user, send Non-user response
    if (!isUserCHOIRUser) {
      const managers = await getManagers(workspaceId);
      const consentFormUrl = process.env.CHOIR_CONSENT_FORM_URL; // Optional consent form URL
      const nonUserMessage = await getNonUserResponseMessage(managers, consentFormUrl, client);

      await client.chat.postMessage({
        channel: event.channel,
        text: nonUserMessage,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: nonUserMessage,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION),
          },
        ],
      });

      logger.info('Non-CHOIR user attempted to use DM', {
        workspaceId,
        userId,
        channel: event.channel,
      });
      return;
    }

    // 사용자 메시지 추출
    const userMessage = 'text' in event && typeof event.text === 'string' ? event.text.trim() : '';
    if (!userMessage) return;

    // 공유 메시지 핸들러를 사용하여 메시지 처리
    await handleIncomingMessage(client, event, userMessage, logger);
  } catch (error) {
    logger.error('Error processing DM message:', error);
    await client.chat.postMessage({
      channel: event.channel,
      text: 'Sorry, an error occurred. Please try again.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Sorry, an error occurred. Please try again.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });
  }
};

const register = (app: App) => {
  app.event('message', dmMessageCallback);
};

export default { register };
