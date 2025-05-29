import type { App, AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { getSessionData, SessionType } from "services/common";
import { getUserName, createQAChannelMessage } from "services/slack";

/**
 * 채널 선택 모달 제출 처리
 */
const askToChannelSubmitCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  try {
    const { sessionId, qaChannelId } = JSON.parse(view.private_metadata);
    const userId = body.user.id;

    if (!sessionId || !qaChannelId) {
      return;
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      return;
    }

    // 사용자 이름 가져오기
    const userName = await getUserName(userId, client);

    // Q&A 채널 이름 가져오기
    let channelName = "qna";
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      channelName = channelInfo.channel?.name || "qna";
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
    }

    // 공통 함수를 사용해 메시지 블록 생성
    const messageBlocks = createQAChannelMessage(
      channelName,
      userId,
      sessionData.originalQuestion,
      sessionData.botResponse
    );

    // Q&A 채널에 메시지 전달
    await client.chat.postMessage({
      channel: qaChannelId,
      text: `Q&A from ${userName}`,
      blocks: messageBlocks
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
  } catch (error) {
    logger.error("Error submitting channel selection:", error);
  }
};

const register = (app: App) => {
  app.view("ask_to_channel_submit", askToChannelSubmitCallback);
};

export default { register }; 