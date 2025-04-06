import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockAction,
  UsersSelectAction,
  ButtonAction,
} from "@slack/bolt";
import {
  addManager,
  removeManager,
  getWorkspaceId,
  isWorkspaceOwner,
  setupInitialManager,
} from "../../services/slack-utils";

// 사용자 선택 상태 저장
const selectedUsers = new Map<string, string>();

/**
 * 사용자 선택 액션 처리
 */
const selectUserCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    // UsersSelect 액션에서 selected_user 속성 추출
    const action = body.actions[0] as UsersSelectAction;
    const selectedUser = action.selected_user;

    // 선택된 사용자가 없는 경우 처리
    if (!selectedUser) {
      logger.error("No user selected in user select action");
      return;
    }

    // 선택된 사용자 저장
    selectedUsers.set(userId, selectedUser);

    logger.info(
      `User ${userId} selected ${selectedUser} for permission management`
    );
  } catch (error) {
    logger.error("Error handling user selection:", error);
  }
};

/**
 * 관리자 권한 부여 액션 처리
 */
const addManagerCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // 워크스페이스 소유자인 경우 초기 관리자로 설정
    const isOwner = await isWorkspaceOwner(userId, client);
    if (isOwner) {
      setupInitialManager(workspaceId, userId);
    }

    // 선택된 사용자 확인
    const selectedUser = selectedUsers.get(userId);
    if (!selectedUser) {
      // 사용자가 선택되지 않은 경우 에러 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "권한을 부여할 사용자를 먼저 선택해주세요.",
      });
      return;
    }

    // 권한 부여 시도
    const success = addManager(workspaceId, selectedUser, userId);

    if (success) {
      // 성공 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: `<@${selectedUser}>에게 관리자 권한을 부여했습니다.`,
      });

      // 홈 화면 새로고침
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "홈 화면을 새로고침 중입니다...",
              },
            },
          ],
        },
      });

      // 알림 메시지 전송
      try {
        await client.chat.postMessage({
          channel: selectedUser,
          text: `<@${userId}>가 당신에게 CHOIR 관리자 권한을 부여했습니다.`,
        });
      } catch (error) {
        logger.error(
          `Failed to send notification to user ${selectedUser}:`,
          error
        );
      }
    } else {
      // 실패 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "권한 부여에 실패했습니다. 관리자 권한이 있는지 확인해주세요.",
      });
    }
  } catch (error) {
    logger.error("Error adding manager permission:", error);
  }
};

/**
 * 관리자 권한 제거 액션 처리
 */
const removeManagerCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // 워크스페이스 소유자인 경우 초기 관리자로 설정
    const isOwner = await isWorkspaceOwner(userId, client);
    if (isOwner) {
      setupInitialManager(workspaceId, userId);
    }

    // 선택된 사용자 확인 - Button 액션에서 value 속성 추출
    const action = body.actions[0] as ButtonAction;
    const targetUserId = action.value;

    // value가 undefined인 경우 처리
    if (!targetUserId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "대상 사용자를 식별할 수 없습니다. 다시 시도해주세요.",
      });
      return;
    }

    // 본인의 권한은 제거할 수 없음
    if (targetUserId === userId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "자신의 관리자 권한은 제거할 수 없습니다.",
      });
      return;
    }

    // 권한 제거 시도
    const success = removeManager(workspaceId, targetUserId, userId);

    if (success) {
      // 성공 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: `<@${targetUserId}>의 관리자 권한을 제거했습니다.`,
      });

      // 홈 화면 새로고침
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "홈 화면을 새로고침 중입니다...",
              },
            },
          ],
        },
      });

      // 알림 메시지 전송
      try {
        await client.chat.postMessage({
          channel: targetUserId,
          text: `<@${userId}>가 당신의 CHOIR 관리자 권한을 제거했습니다.`,
        });
      } catch (error) {
        logger.error(
          `Failed to send notification to user ${targetUserId}:`,
          error
        );
      }
    } else {
      // 실패 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "권한 제거에 실패했습니다. 관리자 권한이 있는지 확인해주세요.",
      });
    }
  } catch (error) {
    logger.error("Error removing manager permission:", error);
  }
};

export { selectUserCallback, addManagerCallback, removeManagerCallback };
