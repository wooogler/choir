import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getUserName, getWorkspaceId } from 'services/slack';

/**
 * "Send Reply to Questioner" 버튼 처리
 */
export const sendReplyToQuestionerCallback = async ({
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
      logger.error('No action value provided for send_reply_to_questioner');
      return;
    }

    const { sessionId, originalQuestionerId } = JSON.parse(actionValue);
    if (!sessionId || !originalQuestionerId) {
      logger.error('Missing sessionId or originalQuestionerId in action value');
      return;
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: "😅 I can't find the conversation details. The session may have expired.",
      });
      return;
    }

    // Thread 메시지들 가져오기 (original message의 thread)
    const channelId = body.channel?.id;
    const messageTs = (body.message as any)?.ts;

    if (!channelId || !messageTs) {
      logger.error('Missing channel ID or message timestamp');
      return;
    }

    // Thread replies 가져오기
    const repliesResponse = await client.conversations.replies({
      channel: channelId,
      ts: messageTs,
      inclusive: false, // 원본 메시지 제외
    });

    const replies = repliesResponse.messages || [];
    
    if (replies.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: '💬 No replies found in this thread. Please add some replies first, then try again.',
      });
      return;
    }

    // Reply 내용들을 수집 (CHOIR 메시지 제외)
    const replyTexts: string[] = [];
    const replyAuthors: string[] = [];

    for (const reply of replies) {
      if (reply.text && reply.user) {
        // CHOIR bot 메시지는 제외 (bot_id가 있거나 특정 조건)
        if ((reply as any).bot_id || (reply as any).subtype === 'bot_message') {
          continue; // CHOIR 메시지 스킵
        }
        
        const authorName = await getUserName(reply.user, client);
        replyTexts.push(reply.text);
        replyAuthors.push(authorName);
      }
    }

    if (replyTexts.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: '💬 No valid replies found. Please make sure there are text replies in this thread.',
      });
      return;
    }

    // 익명 질문자에게 DM으로 답변 전달 (Slack markdown 사용)
    const replySummary = replyTexts.map((text, index) => `*${replyAuthors[index]}:* ${text}`).join('\n\n');

    // 질문자에게는 단순히 답변만 전달 (Update 버튼 없이)
    const dmBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '📬 *Reply Received for Your Anonymous Question*',
        },
        block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Your Original Question:*\n> ${sessionData.originalQuestion}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*My Response:*\n> ${sessionData.botResponse}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Team Member Replies:*\n${replySummary}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ Thanks for your question! The team has provided their input above.',
        },
      },
    ];

    // 익명 질문자에게 DM 전송
    await client.chat.postMessage({
      channel: originalQuestionerId,
      text: 'You received a reply to your anonymous question',
      blocks: dmBlocks,
    });

    // Anonymous 메시지 처리 완료 (더 이상 session tracking 불필요)

    // Manager DM에 Update Documentation 버튼 추가
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs, // 같은 thread에 추가
      text: '✅ Reply sent to questioner. Would you like to update documentation?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '✅ *Reply successfully sent to the anonymous questioner!*',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '📝 *Would you like to update our documentation based on this discussion?*',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Update Documentation',
                emoji: true,
              },
              style: 'primary',
              action_id: 'suggest_updates_from_manager_reply',
              value: JSON.stringify({
                sessionId,
                question: sessionData.originalQuestion,
                response: sessionData.botResponse,
                replies: replyTexts,
                replyAuthors,
                channelId,
                messageTs,
              }),
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'No Thanks',
                emoji: true,
              },
              action_id: 'dismiss_manager_update',
              value: JSON.stringify({ channelId, messageTs }),
            },
          ],
        },
      ],
    });

    logger.info(`Reply sent to anonymous questioner ${originalQuestionerId} from session ${sessionId}`);

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      channelId,
      'dm',
      'send_reply_to_questioner',
      Date.now() - startTime,
      true,
      {
        sessionId,
        originalQuestionerId,
        repliesCount: replyTexts.length,
      },
      client,
    );
  } catch (error) {
    logger.error('Error sending reply to anonymous questioner:', error);

    await client.chat.postEphemeral({
      channel: body.channel?.id || '',
      user: body.user.id,
      text: '😔 Something went wrong sending the reply. Please try again.',
    });

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'dm',
        'send_reply_to_questioner',
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