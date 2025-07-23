import { classifyMessageIntent } from 'services/llm/document-editor';
import {
  getCHOIRUsers,
  getFilteredConversationHistory,
  getOrganizationDescription,
  getOrganizationName,
  getUserName,
  getWorkspaceId,
  isManager,
} from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId, getCHOIRMessageTypeFromBlocks } from 'types/message-types';
import { getAnonymousThreadInfo } from '../../services/common/session-store';
import { logMessageProcessing } from '../../services/common/user-interaction-logger';
import { handleGeneralConversationMessage } from '../features/conversation/general-conversation-handler';
import { handleDMClearCommand } from '../features/dm/clear-handler';
import { handleUpdateRequestMessage } from '../features/document-update/extract-knowledge/update-request-handler';
import { handleQuestionMessage } from '../features/qa/question-handler';

/**
 * 메시지 처리를 위한 공통 함수
 * 공통으로 사용할 수 있도록 mentions와 dms에서 모두 호출 가능
 */
export async function handleIncomingMessage(client: any, event: any, message: string, logger: any) {
  const startTime = Date.now();
  let messageIntent = 'unknown';
  let routingResult: boolean;

  try {
    // Thread message인 경우 원본 메시지가 Anonymous 질문인지 확인
    if (event.thread_ts) {
      // 먼저 mention 여부 확인 (try 블록 밖에서)
      let isMentioned = false;
      try {
        const botInfo = await client.auth.test();
        const botUserId = botInfo.user_id;
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
            if (event.bot_id || event.subtype === 'bot_message') {
              logger.info('Skipping bot message in anonymous thread', {
                channel: event.channel,
                threadTs: event.thread_ts,
                botId: event.bot_id,
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
                text: 'You received a reply to your anonymous question',
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

        // mention되지 않은 경우에만 fallback 체크 수행
        if (!isMentioned) {
          const threadResponse = await client.conversations.history({
            channel: event.channel,
            latest: event.thread_ts,
            inclusive: true,
            limit: 1,
          });

          if (threadResponse.messages && threadResponse.messages.length > 0) {
            const originalMessage = threadResponse.messages[0];
            if (originalMessage.blocks) {
              const messageType = getCHOIRMessageTypeFromBlocks(originalMessage.blocks);
              if (messageType === CHOIRMessageType.ANONYMOUS_QUESTION) {
                logger.info('Skipping thread reply for anonymous question (fallback check)', {
                  channel: event.channel,
                  threadTs: event.thread_ts,
                  messageType,
                });
                return true;
              }
            }
          }
        }
      } catch (historyError) {
        logger.warn('Failed to check thread original message type:', historyError);
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

    // CHOIR 페르소나를 반영한 로딩 메시지 전송 (채널에 표시)
    const loadingMessage = await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: '🤔 Let me think about how I can best help you with that...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🤔 Let me think about how I can best help you with that...',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    // Get organization information
    const workspaceId = await getWorkspaceId(client);
    const orgName = (await getOrganizationName(workspaceId)) || '';
    const orgDescription = (await getOrganizationDescription(workspaceId)) || '';

    // Get CHOIR users for filtering conversation history
    const choirUsers = await getCHOIRUsers(workspaceId);

    // Get filtered conversation history (excludes Non-CHOIR users)
    // Use shorter time limit for DMs since they are more immediate conversations
    const isDM = event.channel_type === 'im';
    const messages = await getFilteredConversationHistory(client, event, choirUsers, {
      timeLimit: isDM ? 30 : 1440, // 30 minutes for DMs, 1 day for channels
      messageLimit: 10, // fetch up to 10 messages
      maxResults: 5, // return up to 5 messages
    });

    // 메시지 의도 분류 (질문 또는 업데이트 요청 또는 일반 대화)
    messageIntent = await classifyMessageIntent(message, orgName, orgDescription, messages, client);
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
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging intent classification:', logError);
    }

    // 로딩 메시지 삭제
    if (loadingMessage.ts) {
      try {
        await client.chat.delete({
          channel: event.channel,
          ts: loadingMessage.ts,
        });
      } catch (deleteError) {
        logger.warn('Failed to delete loading message:', deleteError);
      }
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
