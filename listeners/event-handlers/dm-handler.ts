import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
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
    // DM 메시지인 경우에만 처리
    if (event.channel_type !== 'im') return;

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
    });
  }
};

const register = (app: App) => {
  app.event('message', dmMessageCallback);
};

export default { register };
