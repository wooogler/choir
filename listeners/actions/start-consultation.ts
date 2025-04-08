import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import {
  getManagers,
  getWorkspaceId,
  getUserName,
  SlackMessage,
  Message,
} from "../../services/slack-utils";
import {
  generateSessionId,
  storeSessionData,
  SessionType,
} from "../../services/session-store";

const startConsultationCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    logger.info("rawValue", rawValue);
    if (!rawValue) {
      throw new Error("No value provided");
    }

    const value = JSON.parse(rawValue);
    const { stakeholders, validMessages } = value;
    const uniqueStakeholders = Array.from(new Set(stakeholders)) as string[];

    const userId = body.user.id;

    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(client);

    // 관리자 목록 가져오기
    const managers = getManagers(workspaceId);

    // 현재 사용자가 대화에 참여하는지 확인하고 추가
    const currentUser = body.user.id;
    if (!uniqueStakeholders.includes(currentUser)) {
      uniqueStakeholders.push(currentUser);
    }

    // 관리자도 대화에 자동 포함
    const allParticipants = Array.from(
      new Set([...uniqueStakeholders, ...managers])
    );

    // 이해관계자에서 관리자 제외 (중복 선택 방지)
    const nonManagerStakeholders = uniqueStakeholders.filter(
      (uid) => !managers.includes(uid)
    );

    // 현재 대화 참가자 목록 텍스트 생성
    const stakeholderNames = await Promise.all(
      uniqueStakeholders.map(async (userId) => {
        try {
          const userName = await getUserName(userId, client);
          return `<@${userId}> (${userName})`;
        } catch (error) {
          logger.error(`Error fetching user info for ${userId}:`, error);
          return `<@${userId}>`;
        }
      })
    );

    // 관리자 목록 텍스트 생성
    const managerNames = await Promise.all(
      managers.map(async (managerId) => {
        try {
          const userInfo = await client.users.info({ user: managerId });
          return `<@${managerId}> (${
            userInfo.user?.real_name || userInfo.user?.name || "Unknown"
          })`;
        } catch (error) {
          logger.error(`Error fetching user info for ${managerId}:`, error);
          return `<@${managerId}>`;
        }
      })
    );

    // Slack 블록 생성
    const blocks: any[] = [
      {
        type: "input",
        block_id: "users_block",
        element: {
          type: "multi_users_select",
          action_id: "selected_users",
          initial_users: [...nonManagerStakeholders, ...managers],
          placeholder: {
            type: "plain_text",
            text: "질문에 참가할 사용자 선택",
          },
        },
        label: {
          type: "plain_text",
          text: "참가자",
        },
      },
      {
        type: "divider",
      },
      {
        type: "input",
        block_id: "consultation_topic",
        element: {
          type: "plain_text_input",
          action_id: "topic_input",
          placeholder: {
            type: "plain_text",
            text: "질문 주제를 입력하세요",
          },
        },
        label: {
          type: "plain_text",
          text: "질문 주제",
        },
      },
    ];

    // 관리자 정보 블록 추가
    blocks.push(
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*참여할 관리자*\n관리자는 자동으로 DM에 참여합니다:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            managers.length > 0
              ? managerNames.join("\n")
              : "_관리자가 설정되지 않았습니다_",
        },
      }
    );

    // 현재 대화 참가자 블록 추가
    blocks.push(
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*현재 참가자*:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            stakeholderNames.length > 0
              ? stakeholderNames.join("\n")
              : "_참가자가 없습니다_",
        },
      }
    );

    // 세션 ID 생성
    const sessionId = generateSessionId("consultation");

    // 전체 데이터를 세션 저장소에 저장
    storeSessionData(
      sessionId,
      {
        participants: allParticipants,
        validMessages: validMessages || [],
      },
      SessionType.CONSULTATION
    );

    // private_metadata에는 세션 ID만 전달
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        private_metadata: JSON.stringify({ sessionId }),
        title: {
          type: "plain_text",
          text: "직접 질문하기",
        },
        submit: {
          type: "plain_text",
          text: "시작",
        },
        blocks: blocks,
        callback_id: "create_consultation_room",
      },
    });
  } catch (error) {
    logger.error("Error in start consultation callback:", error);
  }
};

export default startConsultationCallback;
