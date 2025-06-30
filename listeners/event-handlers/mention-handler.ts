import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
// import cancelDocumentUpdatesCallback from "../features/document-update/cancel-document-updates-action"; // 삭제: document-update feature에서 중앙 관리
import { handleIncomingMessage } from './message-router';
// import { rejectUpdateCallback } from "../features/document-update/reject-update"; // 삭제: document-update feature에서 중앙 관리
// import suggestUpdatesCallback from "../features/document-update/suggest-updates"; // 삭제: document-update feature에서 중앙 관리
// import { applySelectedToGithubAction } from "../features/document-update/update-documents"; // 삭제: document-update feature에서 중앙 관리

/**
 * 앱 멘션 처리 콜백
 */
const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'app_mention'>) => {
  try {
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
      text: '죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.',
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
