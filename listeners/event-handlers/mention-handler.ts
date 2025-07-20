import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getManagers, getNonUserResponseMessage, getWorkspaceId, isCHOIRUser } from 'services/slack';
// import { rejectUpdateCallback } from "../features/document-update/reject-update"; // 삭제: document-update feature에서 중앙 관리
// import suggestUpdatesCallback from "../features/document-update/suggest-updates"; // 삭제: document-update feature에서 중앙 관리
// import { applySelectedToGithubAction } from "../features/document-update/update-documents"; // 삭제: document-update feature에서 중앙 관리
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
// import cancelDocumentUpdatesCallback from "../features/document-update/cancel-document-updates-action"; // 삭제: document-update feature에서 중앙 관리
import { handleIncomingMessage } from './message-router';

/**
 * 앱 멘션 처리 콜백
 */
const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'app_mention'>) => {
  try {
    // Get workspace and check if user is a CHOIR user
    const workspaceId = await getWorkspaceId(client);
    const userId = event.user || '';
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

      logger.info('Non-CHOIR user attempted to use mention', {
        workspaceId,
        userId,
        channel: event.channel,
      });
      return;
    }

    // 멘션 이벤트에서 사용자 메시지 추출 (봇 ID 제거)
    const userMessage =
      'text' in event && typeof event.text === 'string' ? event.text.replace(/<@[A-Z0-9]+>/, '').trim() : '';
    if (!userMessage) return;

    // 공유 메시지 핸들러를 사용하여 메시지 처리
    await handleIncomingMessage(client, event, userMessage, logger);
  } catch (error) {
    logger.error('Error processing app mention:', error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
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
  app.event('app_mention', appMentionCallback);
  // 아래 액션 등록들은 features/document-update/index.ts 로 이동됨
  // app.action("suggest_updates", suggestUpdatesCallback);
  // app.action("reject_update", rejectUpdateCallback);
  // app.action("apply_to_document", applySelectedToGithubAction);
  // app.action("cancel_document_updates", cancelDocumentUpdatesCallback);
};

export default { register };
