import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { createQAChannelMessage, getUserName } from 'services/slack';
import { logModalSubmit } from '../../../services/common/user-interaction-logger';

/**
 * 채널 선택 모달 제출 처리
 */
export const askToChannelSubmitCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  const startTime = Date.now();
  await ack();

  try {
    const { sessionId, qaChannelId } = JSON.parse(view.private_metadata);
    const isAnonymous =
      (view.state.values.anonymous_select?.anonymous_checkbox_channel?.selected_options?.length || 0) > 0;
    const userId = body.user.id;

    if (!sessionId || !qaChannelId) {
      // 로그: 필수 데이터 없음
      logModalSubmit(userId, 'unknown', 'ask_to_channel_submit', Date.now() - startTime, false, {
        error: 'Missing sessionId or qaChannelId',
        sessionId,
        qaChannelId,
      });
      return;
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      // 로그: 세션 데이터 없음
      logModalSubmit(userId, 'unknown', 'ask_to_channel_submit', Date.now() - startTime, false, {
        error: 'Session data not found',
        sessionId,
      });
      return;
    }

    // 사용자 이름 가져오기
    const userName = await getUserName(userId, client);

    // Q&A 채널 이름 가져오기
    let channelName = 'qna';
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      channelName = channelInfo.channel?.name || 'qna';
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
    }

    // 공통 함수를 사용해 메시지 블록 생성 (anonymous 옵션 포함)
    const messageBlocks = createQAChannelMessage(
      channelName,
      userId,
      sessionData.originalQuestion,
      sessionData.botResponse,
      true, // canAnswer - assume true for channel sharing
      isAnonymous,
      userName,
    );

    const messageText = isAnonymous ? 'Q&A from a team member' : `Q&A from ${userName}`;

    // Q&A 채널에 메시지 전달
    await client.chat.postMessage({
      channel: qaChannelId,
      text: messageText,
      blocks: messageBlocks,
    });

    // 사용자에게 성공 메시지 전송 (원본 채널이 있는 경우)
    if (sessionData.originalChannelId) {
      await client.chat.postEphemeral({
        channel: sessionData.originalChannelId,
        user: userId,
        text: `✅ Your Q&A has been posted to <#${qaChannelId}>`,
      });
    }

    logger.info(`Q&A posted to channel ${qaChannelId} by user ${userId}`);

    // 로그: 성공
    logModalSubmit(userId, 'unknown', 'ask_to_channel_submit', Date.now() - startTime, true, {
      sessionId,
      qaChannelId,
      qaChannelName: channelName,
      isAnonymous,
      originalChannelId: sessionData.originalChannelId,
      originalThreadTs: sessionData.originalThreadTs,
      questionLength: sessionData.originalQuestion?.length || 0,
      responseLength: sessionData.botResponse?.length || 0,
    });
  } catch (error) {
    logger.error('Error submitting channel selection:', error);

    // 로그: 실패
    logModalSubmit(body.user.id, 'unknown', 'ask_to_channel_submit', Date.now() - startTime, false, {
      error: error instanceof Error ? error.message : 'Unknown error',
      errorStack: error instanceof Error ? error.stack : undefined,
      privateMetadata: view.private_metadata,
    });
  }
};
