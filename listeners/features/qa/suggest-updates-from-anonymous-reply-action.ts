import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getManagers, getUserName, getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { suggestUpdatesCallback } from '../document-update/suggestions/suggest-updates-handler';

/**
 * Anonymous reply에서 "Update Documentation" 버튼 처리
 */
export const suggestUpdatesFromAnonymousReplyCallback = async ({
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
      logger.error('No action value provided for suggest_updates_from_anonymous_reply');
      return;
    }

    const { sessionId, question, response, replies, replyAuthors } = JSON.parse(actionValue);
    if (!sessionId || !question || !response || !replies) {
      logger.error('Missing required data in action value');
      return;
    }

    // 원본 세션 데이터 가져오기
    const originalSessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!originalSessionData) {
      await client.chat.postMessage({
        channel: body.user.id, // DM으로 전송
        text: "😅 I can't find the original conversation details. The session may have expired.",
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: {
              type: 'mrkdwn',
              text: "😅 I can't find the original conversation details. The session may have expired.",
            },
          },
        ],
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
    const newSessionId = `anon_update_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 새 세션 데이터 저장 (원본 데이터 기반으로)
    const newSessionData = {
      ...originalSessionData,
      extractedKnowledge: combinedKnowledge,
      originalQuestion: question,
      botResponse: response,
      anonymousReplies: replies,
      replyAuthors: replyAuthors,
      isFromAnonymousReply: true,
      parentSessionId: sessionId,
    };

    storeSessionData(newSessionId, newSessionData, SessionType.DOCUMENT_UPDATE);

    // Get managers for the workspace
    const workspaceId = await getWorkspaceId(client);
    const managers = await getManagers(workspaceId);
    let managerText = 'managers';
    if (managers.length > 0) {
      // Get first manager's name as example
      const firstManagerName = await getUserName(managers[0], client);
      managerText = managers.length === 1 ? firstManagerName : `${firstManagerName} and other managers`;
    }

    // 성공 메시지 표시
    await client.chat.postMessage({
      channel: body.user.id, // DM으로 전송
      text: `✅ Analysis Complete • 📊 10 messages analyzed\nSure! I'll suggest the following update to ${managerText}.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Analysis Complete* • 📊 10 messages analyzed\nSure! I'll suggest the following update to ${managerText}.`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    // suggestUpdatesCallback 호출하여 문서 업데이트 프로세스 시작
    const modifiedBody = {
      ...body,
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

    logger.info(`Document update started from anonymous reply for session ${sessionId}`);

    // 로그 기록
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.user.id, // DM 채널
      'dm',
      'suggest_updates_from_anonymous_reply',
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
    logger.error('Error handling suggest updates from anonymous reply:', error);

    await client.chat.postMessage({
      channel: body.user.id, // DM으로 전송
      text: '😔 Something went wrong starting the document update. Please try again.',
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          text: { type: 'mrkdwn', text: '😔 Something went wrong starting the document update. Please try again.' },
        },
      ],
    });

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.user.id,
        'dm',
        'suggest_updates_from_anonymous_reply',
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
