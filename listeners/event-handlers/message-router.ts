import { classifyMessageIntent } from 'services/llm/document-editor';
import {
  getCHOIRUsers,
  getFilteredConversationHistory,
  getOrganizationDescription,
  getOrganizationName,
  getWorkspaceId,
  isManager,
} from 'services/slack';
import { getCHOIRMessageTypeFromBlocks, CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { logMessageProcessing } from '../../services/common/user-interaction-logger';
import { handleGeneralConversationMessage } from '../features/conversation/general-conversation-handler';
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
      try {
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
              logger.info('Skipping thread reply for anonymous question', {
                channel: event.channel,
                threadTs: event.thread_ts,
                messageType,
              });
              return true;
            }
          }
        }
      } catch (historyError) {
        logger.warn('Failed to check thread original message type:', historyError);
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
      messageLimit: 10,  // fetch up to 10 messages
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
