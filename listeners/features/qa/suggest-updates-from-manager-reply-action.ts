import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getUserName, getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { suggestUpdatesCallback } from '../document-update/suggestions/suggest-updates';

/**
 * Manager가 "Update Documentation" 버튼을 클릭했을 때 처리
 */
export const suggestUpdatesFromManagerReplyCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const actionValue = body.actions[0].value;
    if (!actionValue) {
      logger.error('No action value provided for suggest_updates_from_manager_reply');
      return;
    }

    const { sessionId, question, response, replies, replyAuthors, channelId, messageTs } = JSON.parse(actionValue);
    if (!sessionId || !question || !response || !replies) {
      logger.error('Missing required data in action value');
      return;
    }

    // 원본 세션 데이터 가져오기
    const originalSessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!originalSessionData) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: "😅 I can't find the original conversation details. The session may have expired.",
      });
      return;
    }

    // Combined knowledge: 원본 질문 + CHOIR 답변 + 팀원들 답변
    const combinedKnowledge = `
**Original Question:** ${question}

**CHOIR's Response:** ${response}

**Team Member Replies:**
${replies.map((reply: string, index: number) => `- ${replyAuthors[index]}: ${reply}`).join('\n')}
    `.trim();

    // 새로운 세션 생성 (document update용)
    const newSessionId = `manager_update_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 새 세션 데이터 저장 (원본 데이터 기반으로)
    const newSessionData = {
      ...originalSessionData,
      extractedKnowledge: combinedKnowledge,
      originalQuestion: question,
      botResponse: response,
      managerReplies: replies,
      replyAuthors: replyAuthors,
      isFromManagerReply: true,
      parentSessionId: sessionId,
    };

    // 매니저 제안 세션은 14일 동안 유효하도록 설정
    const MANAGER_SESSION_EXPIRY = 14 * 24 * 60 * 60 * 1000; // 14일
    storeSessionData(newSessionId, newSessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);

    // 버튼 제거하고 진행 메시지로 업데이트
    const currentMessageTs = (body.message as any)?.ts;
    if (currentMessageTs) {
      await client.chat.update({
        channel: channelId,
        ts: currentMessageTs,
        text: '✅ Analysis Complete • 📊 10 messages analyzed',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "✅ *Analysis Complete* • 📊 10 messages analyzed\nSure! I'll suggest the following update to you.",
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
          },
        ],
      });
    }

    // suggestUpdatesCallback 호출하여 문서 업데이트 프로세스 시작
    const modifiedBody = {
      ...body,
      channel: { id: channelId }, // Manager DM 채널로 설정
      actions: [
        {
          ...body.actions[0],
          value: JSON.stringify({
            sessionId: newSessionId,
            knowledgeContent: combinedKnowledge,
            originalChannelId: originalSessionData.originalChannelId,
            originalThreadTs: originalSessionData.originalThreadTs,
          }),
        },
      ],
    };

    // 기존 suggest updates 로직 재사용
    await suggestUpdatesCallback({
      ack: async () => {}, // 이미 ack했으므로 빈 함수
      body: modifiedBody,
      client,
      logger,
    } as any);

    logger.info(`Document update started by manager for session ${sessionId}`);

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      channelId,
      'dm',
      'suggest_updates_from_manager_reply',
      Date.now() - startTime,
      true,
      {
        originalSessionId: sessionId,
        newSessionId,
        questionLength: question.length,
        responseLength: response.length,
        repliesCount: replies.length,
      },
      client,
    );
  } catch (error) {
    logger.error('Error handling suggest updates from manager reply:', error);

    await client.chat.postEphemeral({
      channel: body.channel?.id || '',
      user: body.user.id,
      text: '😔 Something went wrong starting the document update. Please try again.',
    });

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'dm',
        'suggest_updates_from_manager_reply',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          actionValue: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
