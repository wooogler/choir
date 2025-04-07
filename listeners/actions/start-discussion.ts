import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import {
  getManagers,
  getWorkspaceId,
  getUserName,
} from "../../services/slack-utils";

const startDiscussionCallback = async ({
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
    const { stakeholders, editDataKey, editDataKeys } = value;
    const uniqueStakeholders = Array.from(new Set(stakeholders)) as string[];

    // editDataKey 또는 editDataKeys에서 첫 번째 키 사용
    const finalEditDataKey =
      editDataKey ||
      (editDataKeys && editDataKeys.length > 0 ? editDataKeys[0] : null);

    if (!finalEditDataKey) {
      throw new Error("No edit data key provided");
    }

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

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        private_metadata: JSON.stringify({
          participants: allParticipants,
          editDataKey: finalEditDataKey,
        }),
        title: {
          type: "plain_text",
          text: "Start Discussion",
        },
        submit: {
          type: "plain_text",
          text: "Start",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*참여할 관리자*\n관리자는 자동으로 대화에 참여합니다:",
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
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*현재 대화 참가자*\n문서 업데이트에 사용된 메시지를 발화한 사람들:",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                stakeholderNames.length > 0
                  ? stakeholderNames.join("\n")
                  : "_대화 참가자가 없습니다_",
            },
          },
          {
            type: "divider",
          },
          {
            type: "input",
            block_id: "users_block",
            element: {
              type: "multi_users_select",
              action_id: "selected_users",
              initial_users: nonManagerStakeholders,
              placeholder: {
                type: "plain_text",
                text: "추가 참여자 선택",
              },
            },
            label: {
              type: "plain_text",
              text: "추가 참여자 선택",
            },
            hint: {
              type: "plain_text",
              text: "대화에 참여시킬 추가 사용자를 선택하세요. 관리자는 이미 자동으로 포함되므로 다시 선택하지 않아도 됩니다.",
            },
          },
        ],
        callback_id: "start_discussion_modal",
      },
    });
  } catch (error) {
    logger.error("Error in start discussion callback:", error);
  }
};

export default startDiscussionCallback;
