import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import {
  getManagers,
  getWorkspaceId,
  formatDate,
  createMessageBlock,
  createMessageBlocks,
  createHeaderBlock,
  createSectionBlock,
  createDividerBlock,
  createContextBlock,
  filterNonManagers,
  getUniqueUserIds,
} from "../../services/slack-utils";

interface Message {
  userId: string;
  text: string;
  ts: string;
  username?: string;
}

interface CommitInfo {
  fileName: string;
  updateType: string;
  source: string;
  timestamp: string;
  updatedBy: string;
  nodeIds: string[];
  messages: CommitMessage[];
}

interface CommitMessage {
  userId: string;
  username: string;
  text: string;
  ts: string;
}

interface GithubCommit {
  author: string;
  message: string;
  description: string;
  date: string;
  commitInfo?: CommitInfo;
}

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
    const { participants, commitHistories } = JSON.parse(view.private_metadata);

    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(client);

    // 관리자 목록 가져오기
    const managers = getManagers(workspaceId);

    // 모달에서 선택된 추가 사용자 가져오기
    const selectedUsers =
      view.state.values.users_block.selected_users.selected_users || [];

    // 선택된 사용자 중 관리자가 아닌 사용자만 필터링 (중복 방지)
    const filteredSelectedUsers = filterNonManagers(selectedUsers, managers);

    if (selectedUsers.length !== filteredSelectedUsers.length) {
      logger.info(
        `Filtered out ${
          selectedUsers.length - filteredSelectedUsers.length
        } managers from selection`
      );
    }

    // 모든 참여자 결합 (관리자 + 기본 참가자 + 필터링된 선택 사용자)
    const allUsers = getUniqueUserIds([
      ...participants,
      ...filteredSelectedUsers,
    ]);

    logger.info(`Starting discussion with users: ${allUsers.join(", ")}`);

    // DM 채널 생성
    const result = await client.conversations.open({
      users: allUsers.join(","),
      return_im: true,
    });

    if (!result.channel?.id) {
      throw new Error("Failed to create conversation");
    }

    // 각 파일별 커밋 히스토리에 대해 메시지 전송
    for (const commitHistory of commitHistories) {
      const { fileName, history, validMessages } = commitHistory;

      if (!history || history.length === 0) continue;

      const latestCommit = history[0];
      if (!latestCommit || !latestCommit.commitInfo) continue;

      const commitInfo = latestCommit.commitInfo;
      const messages = commitInfo.messages;

      // 파일 정보 블록
      const fileInfoBlocks = [
        createHeaderBlock("문서 업데이트 논의"),
        createSectionBlock(`*파일:* ${fileName}`),
        createSectionBlock(`*업데이트 유형:* ${commitInfo.updateType}`),
        createSectionBlock(`*수정된 노드:* ${commitInfo.nodeIds.join(", ")}`),
        createDividerBlock(),
        createSectionBlock("*문서 업데이트에 영향을 준 메시지:*"),
      ];

      // validMessages 블록 생성 (문서 업데이트에 영향을 준 메시지)
      const validMessageBlocks =
        validMessages && validMessages.length > 0
          ? validMessages.map(createMessageBlock)
          : [
              createSectionBlock(
                "_문서 업데이트에 영향을 준 메시지가 없습니다._"
              ),
            ];

      // 이전 문서 업데이트에 기여한 메시지 섹션
      const previousMessagesSection = [
        createDividerBlock(),
        createSectionBlock("*이전 문서 업데이트에 기여한 메시지:*"),
      ];

      // 이전 문서 업데이트에 기여한 메시지 블록 생성
      const previousMessageBlocks = messages.map(createMessageBlock);

      // 모든 블록 결합
      const allBlocks = [
        ...fileInfoBlocks,
        ...validMessageBlocks,
        ...previousMessagesSection,
        ...previousMessageBlocks,
        createContextBlock([
          {
            type: "mrkdwn",
            text: `<@${body.user.id}>님이 이 논의를 시작했습니다.`,
          },
        ]),
      ];

      // 메시지 전송
      await client.chat.postMessage({
        channel: result.channel.id,
        blocks: allBlocks,
      });
    }

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
