import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getManagers, getNonUserResponseMessage, getWorkspaceId, isCHOIRUser } from 'services/slack';
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

    // Get workspace and check if user is a CHOIR user
    const workspaceId = await getWorkspaceId(client);
    const userId = 'user' in event ? event.user : '';
    if (!userId) return;

    const isUserCHOIRUser = await isCHOIRUser(workspaceId, userId);

    // If user is not a CHOIR user, send Non-user response
    if (!isUserCHOIRUser) {
      const managers = await getManagers(workspaceId);
      const consentFormUrl = process.env.CHOIR_CONSENT_FORM_URL; // Optional consent form URL
      const nonUserMessage = await getNonUserResponseMessage(managers, consentFormUrl);

      await client.chat.postMessage({
        channel: event.channel,
        text: nonUserMessage,
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
    });
  }
};

const register = (app: App) => {
  app.event('message', dmMessageCallback);
};

export default { register };
