import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { getManagers, getWorkspaceId } from "../../services/slack-utils";
import { DocumentUpdate } from "../../services/document-store";
import {
  DocumentDiff,
  generateDocumentDiffs,
} from "../../services/document-util";
import {
  getSessionData,
  removeSessionData,
} from "../../services/session-store";

interface Message {
  userId: string;
  text: string;
  ts: string;
  username?: string;
}

const createDiscussionRoomCallback = async ({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  await ack();

  try {
    // private_metadata에서 세션 ID 가져오기
    const { sessionId } = JSON.parse(view.private_metadata);

    if (!sessionId) {
      throw new Error("세션 ID가 없습니다");
    }

    // 세션 데이터 가져오기
    const sessionData = getSessionData(sessionId);

    if (!sessionData) {
      throw new Error(`세션 데이터를 찾을 수 없습니다: ${sessionId}`);
    }

    // 세션 데이터에서 필요한 정보 추출
    const { participants, commitHistories, documentDiffs } = sessionData;

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

    logger.info(`Creating discussion with users: ${allUsers.join(", ")}`);

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
      const {
        fileName,
        history,
        validMessages,
        documentDiffs: fileDiffs,
      } = commitHistory;

      if (!history || history.length === 0) continue;

      const latestCommit = history[0];
      if (!latestCommit || !latestCommit.commitInfo) continue;

      const commitInfo = latestCommit.commitInfo;
      const messages = commitInfo.messages;

      // 파일 정보 블록
      const fileInfoBlocks = [
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
            text: `*파일:* ${fileName}`,
          },
        },
      ];

      // Diff 블록 생성 (문서 변경사항 표시)
      const diffBlocks =
        fileDiffs && fileDiffs.length > 0
          ? [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*문서 변경사항:*",
                },
              },
              {
                type: "divider",
              },
              ...fileDiffs.map((diff: DocumentDiff) => diff.diffBlock),
              {
                type: "divider",
              },
            ]
          : [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*문서 변경사항:*",
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "_변경사항 정보를 가져올 수 없습니다._",
                },
              },
              {
                type: "divider",
              },
            ];

      // 업데이트 정보 블록
      const updateInfoBlocks = [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*문서 업데이트에 영향을 준 메시지:*",
          },
        },
      ];

      // validMessages 블록 생성 (문서 업데이트에 영향을 준 메시지)
      const validMessageBlocks =
        validMessages && validMessages.length > 0
          ? validMessages.map((msg: Message) => {
              // 날짜 포맷팅 (예: 2023-05-15T14:30:00Z -> 2023년 5월 15일 14:30)
              const date = new Date(parseInt(msg.ts) * 1000);
              const formattedDate = `${date.getFullYear()}년 ${
                date.getMonth() + 1
              }월 ${date.getDate()}일 ${date.getHours()}:${date
                .getMinutes()
                .toString()
                .padStart(2, "0")}`;

              return {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*${msg.username || "사용자"}* • ${formattedDate}\n${
                    msg.text
                  }`,
                },
              };
            })
          : [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "_문서 업데이트에 영향을 준 메시지가 없습니다._",
                },
              },
            ];

      // 이전 문서 업데이트에 기여한 메시지 섹션
      const previousMessagesSection = [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*이전 문서 업데이트에 기여한 메시지:*",
          },
        },
      ];

      // 이전 문서 업데이트에 기여한 메시지 블록 생성
      const previousMessageBlocks = messages.map((msg: Message) => {
        // 날짜 포맷팅 (예: 2023-05-15T14:30:00Z -> 2023년 5월 15일 14:30)
        const date = new Date(parseInt(msg.ts) * 1000);
        const formattedDate = `${date.getFullYear()}년 ${
          date.getMonth() + 1
        }월 ${date.getDate()}일 ${date.getHours()}:${date
          .getMinutes()
          .toString()
          .padStart(2, "0")}`;

        return {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${msg.username}* • ${formattedDate}\n${msg.text}`,
          },
        };
      });

      // 모든 블록 결합
      const allBlocks = [
        ...fileInfoBlocks,
        ...diffBlocks,
        ...updateInfoBlocks,
        ...validMessageBlocks,
        ...previousMessagesSection,
        ...previousMessageBlocks,
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<@${body.user.id}>님이 이 논의를 시작했습니다.`,
            },
          ],
        },
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

    // 사용이 끝난 세션 데이터 삭제
    removeSessionData(sessionId);
  } catch (error) {
    logger.error("Error in create discussion modal submission:", error);
  }
};

export default createDiscussionRoomCallback;
