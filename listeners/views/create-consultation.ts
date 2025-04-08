import type {
  AllMiddlewareArgs,
  SlackViewMiddlewareArgs,
  SlackViewAction,
} from "@slack/bolt";
import {
  getSessionData,
  removeSessionData,
  SessionType,
} from "../../services/session-store";

interface MessageData {
  username: string;
  text: string;
  ts?: string;
}

const createConsultationRoomCallback = async ({
  ack,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<SlackViewAction>) => {
  try {
    await ack();

    // private_metadata에서 세션 ID 가져오기
    const { sessionId } = JSON.parse(view.private_metadata || "{}");
    if (!sessionId) {
      throw new Error("No session ID provided");
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION);
    if (!sessionData) {
      throw new Error("Session data not found");
    }

    // View의 input 값 파싱
    const selectedUsersValue =
      view.state.values.users_block.selected_users.selected_users || [];
    const topicValue =
      view.state.values.consultation_topic.topic_input.value || "질문";

    // 기존 참가자에 새로 선택한 사용자 추가
    const allParticipants = [
      ...new Set([...sessionData.participants, ...selectedUsersValue]),
    ];

    // DM 채널 생성
    const dmChannelResult = await client.conversations.open({
      users: allParticipants.join(","),
    });
    const channelId = dmChannelResult.channel?.id;

    if (!channelId) {
      throw new Error("Failed to create DM channel");
    }

    // 상담방 시작 메시지 전송
    await client.chat.postMessage({
      channel: channelId,
      text: `*질문 주제: ${topicValue}*\n\n이 DM은 직접 질문을 위해 만들어졌습니다. 모든 참가자가 초대되었습니다.`,
      mrkdwn: true,
    });

    // 관리자 정보 표시
    const managers = await Promise.all(
      allParticipants.map(async (userId) => {
        try {
          const userInfo = await client.users.info({ user: userId });
          return userInfo.user?.is_admin === true ? userId : null;
        } catch (error) {
          logger.error(`Failed to get user info for ${userId}:`, error);
          return null;
        }
      })
    ).then((results) => results.filter((id): id is string => id !== null));

    if (managers.length > 0) {
      const managerNames = await Promise.all(
        managers.map(async (managerId) => {
          try {
            const userInfo = await client.users.info({ user: managerId });
            return `<@${managerId}> (${
              userInfo.user?.real_name || userInfo.user?.name || "Unknown"
            })`;
          } catch (error) {
            logger.error(`Failed to get user info for ${managerId}:`, error);
            return `<@${managerId}>`;
          }
        })
      );

      await client.chat.postMessage({
        channel: channelId,
        text: `*참여할 관리자*\n관리자는 자동으로 질문 대화에 참여합니다:\n${managerNames.join(
          "\n"
        )}`,
        mrkdwn: true,
      });
    }

    // 포함된 메시지가 있으면 스레드로 추가
    if (sessionData.validMessages && sessionData.validMessages.length > 0) {
      const messagesContent = sessionData.validMessages
        .map((msg: MessageData) => `*${msg.username}*\n${msg.text}`)
        .join("\n\n");

      await client.chat.postMessage({
        channel: channelId,
        text: `*참조된 메시지:*\n\n${messagesContent}`,
        mrkdwn: true,
      });
    }

    // 세션 데이터 삭제 (사용 완료)
    removeSessionData(sessionId, SessionType.CONSULTATION);
  } catch (error) {
    logger.error("Error in create consultation room callback:", error);
  }
};

export default createConsultationRoomCallback;
