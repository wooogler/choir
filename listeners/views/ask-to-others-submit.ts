import type { App, AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { getSessionData, SessionType } from "services/common";
import { getUserName, createPrivateMessage } from "services/slack";

/**
 * 멤버 선택 모달 제출 처리
 */
const askToOthersSubmitCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  try {
    const sessionId = view.private_metadata;
    const selectedUsers = view.state.values.users_select.users.selected_users;
    const userId = body.user.id;

    if (!sessionId || !selectedUsers || selectedUsers.length === 0) {
      return;
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      return;
    }

    // 사용자 이름 가져오기
    const userName = await getUserName(userId, client);

    // 선택된 각 멤버에게 DM으로 질문과 답변 전달
    for (const targetUserId of selectedUsers) {
      try {
        // 공통 함수를 사용해 메시지 블록 생성
        const messageBlocks = createPrivateMessage(
          targetUserId,
          userId,
          sessionData.originalQuestion,
          sessionData.botResponse
        );

        await client.chat.postMessage({
          channel: targetUserId,
          text: `Private Q&A from ${userName}`,
          blocks: messageBlocks
        });
      } catch (error) {
        logger.error(`Failed to send private Q&A to user ${targetUserId}:`, error);
      }
    }

    // 사용자에게 성공 메시지 전송 (원본 채널이 있는 경우)
    if (sessionData.originalChannelId) {
      await client.chat.postEphemeral({
        channel: sessionData.originalChannelId,
        user: userId,
        text: `✅ Your Q&A has been sent privately to ${selectedUsers.length} person(s)`,
      });
    }

    logger.info(`Private Q&A sent to ${selectedUsers.length} users by user ${userId}`);
  } catch (error) {
    logger.error("Error submitting member selection:", error);
  }
};

const register = (app: App) => {
  app.view("ask_to_others_submit", askToOthersSubmitCallback);
};

export default { register }; 