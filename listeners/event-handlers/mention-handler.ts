import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getManagers, getNonUserResponseMessage, getWorkspaceId, isCHOIRUser } from 'services/slack';
// import { rejectUpdateCallback } from "../features/document-update/reject-update"; // 삭제: document-update feature에서 중앙 관리
// import suggestUpdatesCallback from "../features/document-update/suggest-updates"; // 삭제: document-update feature에서 중앙 관리
// import { applySelectedToGithubAction } from "../features/document-update/update-documents"; // 삭제: document-update feature에서 중앙 관리
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
// import cancelDocumentUpdatesCallback from "../features/document-update/cancel-document-updates-action"; // 삭제: document-update feature에서 중앙 관리
import { handleIncomingMessage } from './message-router';
import { getOrInitBotUserId } from 'services/slack/user-management';

// 봇 ID 캐싱 - 성능 최적화
let cachedBotUserId: string | null = null;

async function getBotUserId(client: any): Promise<string> {
  if (!cachedBotUserId) {
    const botInfo = await client.auth.test();
    cachedBotUserId = botInfo.user_id;
  }
  return cachedBotUserId!;
}

/**
 * 앱 멘션 처리 콜백
 */
const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'app_mention'>) => {
  try {
    // 봇 메시지 필터링 - 무한 루프 방지
    if (('bot_id' in event && event.bot_id) || event.subtype === 'bot_message') {
      logger.info('Skipping bot message in mention to prevent infinite loop', {
        channel: event.channel,
        botId: 'bot_id' in event ? event.bot_id : undefined,
        subtype: event.subtype,
      });
      return;
    }

    // 추가 안전장치: 자신의 메시지인지 확인
    try {
      const botUserId = await getOrInitBotUserId(client);
      if ('user' in event && event.user === botUserId) {
        logger.info('Skipping own message in mention to prevent infinite loop', {
          channel: event.channel,
          userId: 'user' in event ? event.user : undefined,
        });
        return;
      }
    } catch (authError) {
      logger.warn('Could not verify bot user ID for message filtering:', authError);
    }

    // 추가 봇 필터링 - 포괄적 무한 루프 방지
    const userId = event.user || '';
    if (!userId) return;
    
    // SLACKBOT 및 기타 시스템 봇 필터링
    if (userId === 'USLACKBOT') {
      logger.info('Skipping SLACKBOT message in mention to prevent infinite loop', {
        channel: event.channel,
        userId: userId,
      });
      return;
    }
    
    // 봇 사용자 ID 패턴 필터링 (대부분 봇은 B로 시작하거나 특별한 패턴)
    // Google Drive bot, 기타 앱 봇들을 포괄적으로 필터링
    if (userId.startsWith('B') || userId.includes('bot') || userId.includes('BOT')) {
      logger.info('Skipping bot user message in mention to prevent infinite loop', {
        channel: event.channel,
        userId: userId,
        reason: 'Bot user ID pattern detected',
      });
      return;
    }

    // Get workspace and check if user is a CHOIR user
    const workspaceId = await getWorkspaceId(client);

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
