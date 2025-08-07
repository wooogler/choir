import { classifyMessageIntent } from 'services/llm/document-editor';
import {
  getOrganizationDescription,
  getOrganizationName,
  getUserName,
  getWorkspaceId,
  getOrInitBotUserId,
} from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { getAnonymousThreadInfo } from '../../services/common/session-store';
import { logMessageProcessing } from '../../services/common/user-interaction-logger';
import { handleGeneralConversationMessage } from '../features/conversation/general-conversation-handler';
import { handleDMClearCommand } from '../features/dm/clear-handler';
import { handleUpdateRequestMessage } from '../features/document-update/extract-knowledge/update-request-handler';
import { handleQuestionMessage } from '../features/qa/question-handler';

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
 * 메시지 처리를 위한 공통 함수
 * 공통으로 사용할 수 있도록 mentions와 dms에서 모두 호출 가능
 */
export async function handleIncomingMessage(client: any, event: any, message: string, logger: any) {
  const startTime = Date.now();
  let messageIntent = 'unknown';
  let routingResult: boolean;

  try {
    // 전역 봇 메시지 필터링 - 무한 루프 방지 (추가 안전장치)
    if (('bot_id' in event && event.bot_id) || event.subtype === 'bot_message') {
      logger.info('Skipping bot message in message router to prevent infinite loop', {
        channel: event.channel,
        botId: 'bot_id' in event ? event.bot_id : undefined,
        subtype: event.subtype,
      });
      return true;
    }

    // 추가 안전장치: 자신의 메시지인지 확인
    try {
      const botUserId = await getOrInitBotUserId(client);
      if ('user' in event && event.user === botUserId) {
        logger.info('Skipping own message in message router to prevent infinite loop', {
          channel: event.channel,
          userId: 'user' in event ? event.user : undefined,
        });
        return true;
      }
    } catch (authError) {
      logger.warn('Could not verify bot user ID for message filtering in router:', authError);
    }

    // Thread message인 경우 원본 메시지가 Anonymous 질문인지 확인
    if (event.thread_ts) {
      // 먼저 mention 여부 확인 (try 블록 밖에서)
      let isMentioned = false;
      try {
        const botUserId = await getOrInitBotUserId(client);
        isMentioned = message.includes(`<@${botUserId}>`) || message.includes('@choir');

        // mention된 경우에는 익명 thread 체크를 우회하고 정상 처리
        if (isMentioned) {
          logger.info('CHOIR mentioned in thread - bypassing anonymous checks', {
            channel: event.channel,
            threadTs: event.thread_ts,
          });
          // mention된 경우 정상적인 메시지 처리 흐름으로 넘어감 (모든 익명 체크 우회)
        } else {
          // mention되지 않은 경우에만 익명 thread 체크
          const anonymousInfo = getAnonymousThreadInfo(event.channel, event.thread_ts);
          if (anonymousInfo) {
            // Bot 메시지는 전달하지 않음 (CHOIR의 안내 메시지 등)
            if (('bot_id' in event && event.bot_id) || event.subtype === 'bot_message') {
              logger.info('Skipping bot message in anonymous thread', {
                channel: event.channel,
                threadTs: event.thread_ts,
                botId: 'bot_id' in event ? event.bot_id : undefined,
                subtype: event.subtype,
              });
              return true;
            }

            // Mention되지 않은 일반 메시지는 원래 질문자에게 전달
            logger.info('Forwarding thread reply to anonymous questioner', {
              channel: event.channel,
              threadTs: event.thread_ts,
              originalQuestionerId: anonymousInfo.originalQuestionerId,
            });

            // 메시지 작성자 이름 가져오기
            const authorName = await getUserName(event.user, client);

            // 원래 질문자에게 DM 전송
            try {
              await client.chat.postMessage({
                channel: anonymousInfo.originalQuestionerId,
                text: `${authorName}: ${message}`,
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `💬 *${authorName}* replied to your anonymous question:\n\n${message}`,
                    },
                  },
                ],
              });

              logger.info('Successfully forwarded thread reply to anonymous questioner', {
                originalQuestionerId: anonymousInfo.originalQuestionerId,
                authorName,
              });
            } catch (dmError) {
              logger.error('Failed to forward thread reply to anonymous questioner:', dmError);
            }

            return true;
          }
        }

        // Skip fallback API check to avoid rate limits - rely on session store only
      } catch (error) {
        logger.warn('Error in anonymous thread check:', error);
      }
    }

    // DM에서 Clear 명령어 체크 (로딩 메시지 전에)
    if (event.channel_type === 'im') {
      const clearCommands = ['clear', 'reset', '/clear', '/reset', 'clear chat', 'reset chat'];
      const isClearCommand = clearCommands.some(
        (cmd) =>
          message.trim().toLowerCase() === cmd ||
          message
            .trim()
            .toLowerCase()
            .startsWith(cmd + ' '),
      );

      if (isClearCommand) {
        logger.info('MessageRouter: DM Clear command detected');
        return await handleDMClearCommand(client, event, logger);
      }
    }

    // Get organization information
    const workspaceId = await getWorkspaceId(client);
    const orgName = (await getOrganizationName(workspaceId)) || '';
    const orgDescription = (await getOrganizationDescription(workspaceId)) || '';

    // Skip getting CHOIR users since we're not using conversation history
    // const choirUsers = await getCHOIRUsers(workspaceId);

    // Skip conversation history for classify intent to avoid API rate limits
    // const isDM = event.channel_type === 'im';
    // const conversationCache = ConversationCache.getInstance();
    // const messages = await conversationCache.getOrFetchHistory(client, event, choirUsers, {
    //   timeLimit: isDM ? 30 : 1440, // 30 minutes for DMs, 1 day for channels
    //   messageLimit: 10, // fetch up to 10 messages
    //   maxResults: 5, // return up to 5 messages
    // });

    // 메시지 의도 분류 (질문 또는 업데이트 요청 또는 일반 대화) - without conversation history
    messageIntent = await classifyMessageIntent(message, orgName, orgDescription, [], client);
    logger.info(`Message intent classified as: ${messageIntent}`);

    // Log the intent classification result to interaction logs
    try {
      await logMessageProcessing(
        event.user,
        workspaceId,
        event.channel,
        event.channel_type || 'public',
        !!event.thread_ts,
        Date.now() - startTime,
        true,
        message,
        'classify_intent',
        {
          messageIntent,
          orgName,
          orgDescription,
          messageLength: message.length,
          fullMessageContent: message,
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging intent classification:', logError);
    }

    if (messageIntent === 'question') {
      // 질문으로 처리
      logger.info('MessageRouter: Routing to handleQuestionMessage');
      routingResult = await handleQuestionMessage(client, event, message, logger);
      logger.info('MessageRouter: handleQuestionMessage completed');
    } else if (messageIntent === 'update_request') {
      // 업데이트 요청으로 처리
      logger.info('MessageRouter: Routing to handleUpdateRequestMessage');
      routingResult = await handleUpdateRequestMessage(client, event, logger);
      logger.info('MessageRouter: handleUpdateRequestMessage completed');
    } else {
      // 일반 대화로 처리
      logger.info(`MessageRouter: Routing to handleGeneralConversationMessage (intent: ${messageIntent})`);
      routingResult = await handleGeneralConversationMessage(client, event, message, logger);
      logger.info('MessageRouter: handleGeneralConversationMessage completed');
    }

    return routingResult;
  } catch (error) {
    logger.error('Error processing message:', error);

    // 실패 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logMessageProcessing(
        event.user,
        workspaceId,
        event.channel,
        event.channel_type || 'public',
        !!event.thread_ts,
        Date.now() - startTime,
        false,
        message,
        'message_routing',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          messageIntent: messageIntent || 'unknown',
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging message routing failure:', logError);
    }

    await client.chat.postMessage({
      channel: event.channel,
      ...(event.channel_type !== 'im' ? { thread_ts: event.ts } : {}), // DM이 아닌 경우에만 스레드로 응답
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
    return false;
  }
}
