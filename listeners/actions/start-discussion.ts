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
  parseGithubUrl,
  Message,
} from "../../services/slack-utils";
import {
  DocumentUpdate,
  getSelectedNodeIds,
  getStoredDocumentUpdates,
} from "../../services/document-store";
import GithubService from "../../services/github";
import { VectorStoreService } from "../../services";
import {
  updateDocTreeWithChanges,
  updateNodeContent,
} from "../../services/markdown";

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
    const { stakeholders, validMessages } = value;
    const uniqueStakeholders = Array.from(new Set(stakeholders)) as string[];

    const userId = body.user.id;

    const documentUpdates = await getStoredDocumentUpdates(userId);
    const selectedNodeIds = getSelectedNodeIds(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      throw new Error("No document updates found");
    }

    const nodesByFile = new Map<
      string,
      {
        nodeIds: string[];
        githubUrl: string;
        fileName: string;
        documentUpdates: DocumentUpdate[];
      }
    >();

    for (const nodeId of selectedNodeIds) {
      const update = documentUpdates.find((update) => update.nodeId === nodeId);
      if (update) {
        const fileName = update.fileName;
        const githubUrl = update.githubUrl;

        if (!nodesByFile.has(fileName)) {
          nodesByFile.set(fileName, {
            nodeIds: [],
            githubUrl,
            fileName,
            documentUpdates: [],
          });
        }

        nodesByFile.get(fileName)!.nodeIds.push(nodeId);
        nodesByFile.get(fileName)!.documentUpdates.push(update);
      } else {
        console.log(
          `노드 ID ${nodeId}에 대한 업데이트 정보를 찾을 수 없습니다.`
        );
      }
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

    // GitHub 커밋 히스토리 가져오기
    const githubService = GithubService.getInstance();
    const vectorStore = VectorStoreService.getInstance();
    const fileChanges = [];
    for (const [fileName, fileData] of nodesByFile.entries()) {
      // 마크다운 파일 가져오기
      console.log(
        `'${fileName}' 파일의 ${fileData.nodeIds.length}개 노드 업데이트 중...`
      );

      const markdownFile = vectorStore.getMarkdownFile(fileName);
      if (!markdownFile) {
        console.error(`파일을 찾을 수 없습니다: ${fileName}`);
        continue;
      }

      let docTree = markdownFile.tree;
      const githubInfo = parseGithubUrl(fileData.githubUrl);
      if (!githubInfo) {
        console.error(`유효한 GitHub URL이 아닙니다: ${fileData.githubUrl}`);
        continue;
      }

      for (const update of fileData.documentUpdates) {
        const nodeId = update.nodeId;
        const updatedNodeContent = update.updatedNodeContent;

        docTree = updateNodeContent(docTree, nodeId, updatedNodeContent);
      }

      const updatedMarkdown = updateDocTreeWithChanges(
        docTree,
        fileData.documentUpdates
      );

      fileChanges.push({
        fileName,
        updatedMarkdown,
        githubInfo,
      });
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
    // documentUpdates 대신 commitHistories만 사용
    const simplifiedCommitHistories = commitHistories
      .filter((history) => history !== null)
      .map((history) => {
        if (!history) return null;
        return {
          fileName: history.fileName,
          history: history.history,
          validMessages: validMessages || [],
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

        return [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${fileName} 파일의 메시지:*`,
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

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        private_metadata: JSON.stringify({
          participants: allParticipants,
          commitHistories: simplifiedCommitHistories,
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
            type: "input",
            block_id: "users_block",
            element: {
              type: "multi_users_select",
              action_id: "selected_users",
              initial_users: initialUsers,
              placeholder: {
                type: "plain_text",
                text: "대화 참가자 선택",
              },
            },
            label: {
              type: "plain_text",
              text: "대화 참가자",
            },
          },
          {
            type: "divider",
          },
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
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*이전 문서 기여자*\n이전에 이 문서를 업데이트한 사람들:",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                commitHistoryUserNames.length > 0
                  ? commitHistoryUserNames.join("\n")
                  : "_이전 기여자가 없습니다_",
            },
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*이전 문서 업데이트 대화 내용*\n이전에 이 문서를 업데이트할 때 나눈 대화 내용입니다. 이 정보는 대화의 맥락을 이해하는 데 도움이 됩니다.",
            },
          },
          // 커밋 히스토리 블록 추가
          ...commitHistoryBlocks,
        ],
        callback_id: "start_discussion_modal",
      },
    });
  } catch (error) {
    logger.error("Error in start discussion callback:", error);
  }
};

export default startDiscussionCallback;
