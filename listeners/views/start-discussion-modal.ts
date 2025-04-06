import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import {
  getStoredEditData,
  getManagers,
  getWorkspaceId,
} from "../../services/slack-utils";

const startDiscussionModalCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  try {
    // private_metadata에서 정보 가져오기
    const { participants, editDataKey } = JSON.parse(view.private_metadata);

    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(client);

    // 관리자 목록 가져오기
    const managers = getManagers(workspaceId);

    // 모달에서 선택된 추가 사용자 가져오기
    const selectedUsers =
      view.state.values.users_block.selected_users.selected_users || [];

    // 선택된 사용자 중 관리자가 아닌 사용자만 필터링 (중복 방지)
    const filteredSelectedUsers = selectedUsers.filter(
      (user) => !managers.includes(user)
    );

    if (selectedUsers.length !== filteredSelectedUsers.length) {
      logger.info(
        `Filtered out ${
          selectedUsers.length - filteredSelectedUsers.length
        } managers from selection`
      );
    }

    // 모든 참여자 결합 (관리자 + 기본 참가자 + 필터링된 선택 사용자)
    const allUsers = Array.from(
      new Set([...participants, ...filteredSelectedUsers])
    );

    logger.info(`Starting discussion with users: ${allUsers.join(", ")}`);

    // 편집 데이터 가져오기
    const editData = getStoredEditData(editDataKey);
    if (!editData) {
      throw new Error("Edit data not found");
    }

    // DM 채널 생성
    const result = await client.conversations.open({
      users: allUsers.join(","),
      return_im: true,
    });

    if (!result.channel?.id) {
      throw new Error("Failed to create conversation");
    }

    // DM 채널에 메시지 전송
    await client.chat.postMessage({
      channel: result.channel.id,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "문서 업데이트 논의",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*파일:* <${editData.fileName}>`,
          },
        },
        editData.diffBlock,
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<@${body.user.id}>님이 이 논의를 시작했습니다.`,
            },
          ],
        },
      ],
    });

    // 요약 메시지도 보내기
    await client.chat.postMessage({
      channel: result.channel.id,
      text:
        "다음 사용자가 이 논의에 참여하고 있습니다: " +
        allUsers.map((uid) => `<@${uid}>`).join(", "),
    });
  } catch (error) {
    logger.error("Error in start discussion modal submission:", error);
  }
};

export default startDiscussionModalCallback;
