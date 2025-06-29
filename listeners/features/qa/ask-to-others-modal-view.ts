import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { getSessionData, SessionType } from "services/common";
import { getUserName, createPrivateMessage } from "services/slack";
import { logModalSubmit } from "../../../services/common/user-interaction-logger";

/**
 * 멤버 선택 모달 제출 처리
 */
export const askToOthersSubmitCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  const startTime = Date.now();
  await ack();

  try {
    const sessionId = view.private_metadata;
    const selectedUsers = view.state.values.users_select.users.selected_users;
    const isAnonymous = (view.state.values.anonymous_select?.anonymous_checkbox_private?.selected_options?.length || 0) > 0;
    const userId = body.user.id;

    if (!sessionId || !selectedUsers || selectedUsers.length === 0) {
      // 로그: 필수 데이터 없음
      logModalSubmit(
        userId,
        'unknown',
        'ask_to_others_submit',
        Date.now() - startTime,
        false,
        {
          error: "Missing sessionId or selectedUsers",
          sessionId,
          selectedUsersCount: selectedUsers?.length || 0
        }
      );
      return;
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      // 로그: 세션 데이터 없음
      logModalSubmit(
        userId,
        'unknown',
        'ask_to_others_submit',
        Date.now() - startTime,
        false,
        {
          error: "Session data not found",
          sessionId
        }
      );
      return;
    }

    // 사용자 이름 가져오기
    const userName = await getUserName(userId, client);

    // 선택된 각 멤버에게 DM으로 질문과 답변 전달
    let successCount = 0;
    let failCount = 0;
    for (const targetUserId of selectedUsers) {
      try {
        // 공통 함수를 사용해 메시지 블록 생성 (anonymous 옵션 포함)
        const messageBlocks = createPrivateMessage(
          targetUserId,
          userId,
          sessionData.originalQuestion,
          sessionData.botResponse,
          true, // canAnswer - assume true for private sharing
          isAnonymous,
          userName
        );

        const messageText = isAnonymous ? "Private Q&A from a team member" : `Private Q&A from ${userName}`;
        
        await client.chat.postMessage({
          channel: targetUserId,
          text: messageText,
          blocks: messageBlocks
        });
        successCount++;
      } catch (error) {
        logger.error(`Failed to send private Q&A to user ${targetUserId}:`, error);
        failCount++;
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

    // 로그: 성공
    logModalSubmit(
      userId,
      'unknown',
      'ask_to_others_submit',
      Date.now() - startTime,
      true,
      {
        sessionId,
        selectedUsersCount: selectedUsers.length,
        successCount,
        failCount,
        isAnonymous,
        originalChannelId: sessionData.originalChannelId,
        originalThreadTs: sessionData.originalThreadTs,
        questionLength: sessionData.originalQuestion?.length || 0,
        responseLength: sessionData.botResponse?.length || 0
      }
    );

  } catch (error) {
    logger.error("Error submitting member selection:", error);

    // 로그: 실패
    logModalSubmit(
      body.user.id,
      'unknown',
      'ask_to_others_submit',
      Date.now() - startTime,
      false,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        errorStack: error instanceof Error ? error.stack : undefined,
        sessionId: view.private_metadata
      }
    );
  }
};