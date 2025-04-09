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
  formatTimestampToDateString,
} from "../../services/slack-utils";
import {
  DocumentUpdate,
  getSelectedNodeIds,
  getStoredDocumentUpdates,
} from "../../services/document-store";
import GithubService from "../../services/github";
import { VectorStoreService } from "../../services";
import {
  groupNodesByFile,
  processFileChanges,
  generateDocumentDiffs,
} from "../../services/document-util";
import {
  generateSessionId,
  storeSessionData,
  SessionType,
} from "../../services/session-store";

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
    logger.info("Parsed value:", JSON.stringify(value, null, 2));
    const { stakeholders, validMessages } = value;
    logger.info(`Stakeholders: ${JSON.stringify(stakeholders)}`);
    logger.info(`Valid messages count: ${validMessages?.length || 0}`);
    const uniqueStakeholders = Array.from(new Set(stakeholders)) as string[];

    const userId = body.user.id;

    const documentUpdates = await getStoredDocumentUpdates(userId);
    const selectedNodeIds = getSelectedNodeIds(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      throw new Error("No document updates found");
    }

    // 선택된 노드의 업데이트만 필터링
    const selectedUpdates = documentUpdates.filter((update) =>
      selectedNodeIds.includes(update.nodeId)
    );

    // Diff 생성
    const documentDiffs = await generateDocumentDiffs(selectedUpdates);

    const nodesByFile = groupNodesByFile(selectedNodeIds, documentUpdates);

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

    // GitHub 커밋 히스토리 가져오기
    const githubService = GithubService.getInstance();
    const vectorStore = VectorStoreService.getInstance();
    const fileChanges = [];

    // 각 파일에 대한 변경사항 처리
    for (const [fileName, fileData] of nodesByFile.entries()) {
      const { success, message, updatedMarkdown, githubInfo } =
        await processFileChanges(fileName, fileData, vectorStore);

      if (success && updatedMarkdown && githubInfo) {
        fileChanges.push({
          fileName,
          updatedMarkdown,
          githubInfo,
        });
      } else {
        console.error(message);
      }
    }

    const commitHistories = await Promise.all(
      fileChanges.map(async (fileChange) => {
        const { fileName, updatedMarkdown, githubInfo } = fileChange;

        try {
          const history = await githubService.getHistoryOfMarkdownUpdate({
            owner: githubInfo.owner,
            repo: githubInfo.repo,
            path: fileName,
            newContent: updatedMarkdown,
            limit: 1,
          });

          return {
            fileName,
            history,
          };
        } catch (error) {
          logger.error(`Error fetching commit history for ${fileName}:`, error);
          return null;
        }
      })
    );

    // private_metadata에 저장할 데이터 최소화
    const simplifiedCommitHistories = commitHistories
      .filter((history) => history !== null)
      .map((history) => {
        if (!history) return null;

        // 해당 파일의 documentDiffs 찾기
        const fileDiffs = documentDiffs.filter(
          (diff) => diff.fileName === history.fileName
        );

        return {
          fileName: history.fileName,
          history: history.history,
          validMessages: validMessages || [],
          documentDiffs: fileDiffs || [],
        };
      })
      .filter((history) => history !== null);

    // 커밋 히스토리 정보를 포함한 블록 생성
    const commitHistoryBlocks = commitHistories
      .filter((history) => history !== null)
      .map((commitHistory) => {
        if (!commitHistory) return null;

        const { fileName, history } = commitHistory;

        // 가장 최근 커밋에서 메시지 정보 추출
        const latestCommit = history[0];
        if (
          !latestCommit ||
          !latestCommit.commitInfo ||
          !latestCommit.commitInfo.messages
        ) {
          return null;
        }

        const messages = latestCommit.commitInfo.messages;

        // 메시지 블록 생성
        const messageBlocks = messages.map((msg: Message) => {
          // Use the date formatting function
          const formattedDate = formatTimestampToDateString(msg.ts);

          return {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${msg.username}* • ${formattedDate}\n${msg.text}`,
            },
          };
        });

        return [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Messages in the file:*`,
            },
          },
          ...messageBlocks,
          {
            type: "divider",
          },
        ];
      })
      .filter((block) => block !== null)
      .flat();

    // commitHistory에서 참가한 유저 ID 추출
    const commitHistoryUserIds = new Set<string>();
    commitHistories.forEach((history) => {
      if (history && history.history && history.history.length > 0) {
        const latestCommit = history.history[0];
        if (
          latestCommit &&
          latestCommit.commitInfo &&
          latestCommit.commitInfo.messages
        ) {
          latestCommit.commitInfo.messages.forEach((msg: any) => {
            if (msg.userId) {
              commitHistoryUserIds.add(msg.userId);
            }
          });
        }
      }
    });

    // 이전 문서 기여자 이름 목록 생성
    const commitHistoryUserNames = await Promise.all(
      Array.from(commitHistoryUserIds).map(async (userId) => {
        try {
          const userName = await getUserName(userId, client);
          return `<@${userId}> (${userName})`;
        } catch (error) {
          logger.error(`Error fetching user info for ${userId}:`, error);
          return `<@${userId}>`;
        }
      })
    );

    // 추가 참여자 선택에 commitHistory에서 참가한 유저 ID 추가
    const initialUsers = Array.from(
      new Set([...nonManagerStakeholders, ...Array.from(commitHistoryUserIds)])
    );

    // 문서 변경사항 블록 생성
    const documentDiffBlocks = documentDiffs
      .map((diff) => {
        return [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*File:* ${diff.fileName}\n*Section:* ${diff.markdownSection}`,
            },
          },
          {
            type: "divider",
          },
          diff.diffBlock,
          {
            type: "divider",
          },
        ];
      })
      .flat();

    // Slack 블록 생성
    const blocks: any[] = [
      {
        type: "input",
        block_id: "users_block",
        element: {
          type: "multi_users_select",
          action_id: "selected_users",
          initial_users: initialUsers,
          placeholder: {
            type: "plain_text",
            text: "Select discussion participants",
          },
        },
        label: {
          type: "plain_text",
          text: "Discussion Participants",
        },
      },
    ];

    // 문서 변경사항 블록이 있는 경우 추가
    // if (documentDiffBlocks.length > 0) {
    //   blocks.push(
    //     {
    //       type: "divider",
    //     },
    //     {
    //       type: "section",
    //       text: {
    //         type: "mrkdwn",
    //         text: "*Document Changes*",
    //       },
    //     },
    //     ...documentDiffBlocks
    //   );
    // }

    // 관리자 정보 블록 추가
    blocks.push(
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Participating Managers*\nManagers automatically join the discussion:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            managers.length > 0
              ? managerNames.join("\n")
              : "_No managers have been set up_",
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
          text: "*Current Discussion Participants*\nPeople who sent messages used for document updates:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            stakeholderNames.length > 0
              ? stakeholderNames.join("\n")
              : "_No participants_",
        },
      }
    );

    // 이전 문서 기여자 블록 추가
    blocks.push(
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Previous Document Contributors*\nPeople who previously updated this document:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            commitHistoryUserNames.length > 0
              ? commitHistoryUserNames.join("\n")
              : "_No previous contributors_",
        },
      }
    );

    //이전 문서 업데이트 대화 내용 블록 추가
    if (commitHistoryBlocks.length > 0) {
      blocks.push(
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Previous Document Update Discussions*\nConversations from previous document updates. This information helps understand the context of the discussion.",
          },
        },
        ...commitHistoryBlocks
      );
    }

    // 세션 ID 생성
    const sessionId = generateSessionId("discussion");
    logger.info(`Generated session ID: ${sessionId}`);

    // 전체 데이터를 세션 저장소에 저장
    storeSessionData(
      sessionId,
      {
        participants: allParticipants,
        commitHistories: simplifiedCommitHistories,
        documentDiffs,
        validMessages,
        stakeholders: uniqueStakeholders,
      },
      SessionType.DISCUSSION
    );

    logger.info(`Session data stored with ID: ${sessionId}`);

    try {
      // trigger_id 유효성 확인
      const triggerId = body.trigger_id;
      logger.info(`Using trigger_id: ${triggerId}`);

      // private_metadata에는 세션 ID만 전달
      const result = await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          private_metadata: JSON.stringify({ sessionId }),
          title: {
            type: "plain_text",
            text: "Start Discussion",
          },
          submit: {
            type: "plain_text",
            text: "Start",
          },
          blocks: blocks,
          callback_id: "create_discussion_room",
        },
      });

      logger.info(`Modal opened successfully: ${result.view?.id}`);
    } catch (error: any) {
      logger.error(`Error opening modal: ${error.message || error}`);

      // trigger_id 관련 오류인 경우 사용자에게 알림
      if (
        error.data?.error === "exchanged_trigger_id" ||
        error.data?.error === "expired_trigger_id"
      ) {
        try {
          await client.chat.postEphemeral({
            channel: body.channel?.id || "",
            user: body.user.id,
            text: "논의 시작 버튼을 다시 클릭해주세요. 이전 요청이 만료되었습니다.",
          });
        } catch (notifyError: any) {
          logger.error(
            `Error sending notification: ${notifyError.message || notifyError}`
          );
        }
      }
    }
  } catch (error) {
    logger.error("Error in start discussion callback:", error);
  }
};

export default startDiscussionCallback;
