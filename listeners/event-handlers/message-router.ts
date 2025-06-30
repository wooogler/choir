import { classifyMessageIntent } from 'services/llm/document-editor';
import { getOrganizationDescription, getOrganizationName, getWorkspaceId, isManager } from 'services/slack';
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
    // CHOIR 페르소나를 반영한 로딩 메시지 전송 (채널에 표시)
    const loadingMessage = await client.chat.postMessage({
      channel: event.channel,
      text: '🤔 Let me think about how I can best help you with that...',
    });

    // Get organization information
    const workspaceId = await getWorkspaceId(client);
    const orgName = (await getOrganizationName(workspaceId)) || '';
    const orgDescription = (await getOrganizationDescription(workspaceId)) || '';

    // 메시지 의도 분류 (질문 또는 업데이트 요청 또는 일반 대화)
    messageIntent = await classifyMessageIntent(message, orgName, orgDescription);
    logger.info(`Message intent classified as: ${messageIntent}`);

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
      routingResult = await handleQuestionMessage(client, event, message, logger);
    } else if (messageIntent === 'update_request') {
      // 업데이트 요청으로 처리
      routingResult = await handleUpdateRequestMessage(client, event, logger);
    } else {
      // 일반 대화로 처리
      routingResult = await handleGeneralConversationMessage(client, event, message, logger);
    }

    // 성공 로깅
    logMessageProcessing(
      event.user,
      workspaceId,
      event.channel,
      event.channel_type || 'public',
      !!event.thread_ts,
      Date.now() - startTime,
      routingResult,
      message,
      'message_routing',
      {
        messageIntent,
        orgName,
        orgDescription,
        routingSuccess: routingResult,
      },
    );

    return routingResult;
  } catch (error) {
    logger.error('Error processing message:', error);

    // 실패 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      logMessageProcessing(
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
      );
    } catch (logError) {
      logger.error('Error logging message routing failure:', logError);
    }

    await client.chat.postMessage({
      channel: event.channel,
      ...(event.channel_type !== 'im' ? { thread_ts: event.ts } : {}), // DM이 아닌 경우에만 스레드로 응답
      text: '죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.',
    });
    return false;
  }
}
