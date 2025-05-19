import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockAction,
  UsersSelectAction,
} from "@slack/bolt";
import { DocumentUpdate, getStoredDocumentUpdates, getSelectedNodeIds } from "services/document";
import GithubService from "services/github";

// Store user selection state
const selectedUsers = new Map<string, string>();

/**
 * Handle user selection action
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
    // UsersSelect action from value
    const action = body.actions[0] as UsersSelectAction;
    const selectedUser = action.selected_user;

    // No user selected
    if (!selectedUser) {
      logger.error("No user selected in user select action");
      return;
    }

    // Store selected user
    selectedUsers.set(userId, selectedUser);

    logger.info(`User ${userId} selected ${selectedUser} for document update`);
  } catch (error) {
    logger.error("Error handling user selection:", error);
  }
};

export { selectUserCallback };

// Apply changes to GitHub
const applySelectedToGithubAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const channelId = body.channel?.id;

    if (!channelId) {
      throw new Error("채널 ID를 찾을 수 없습니다");
    }

    // 선택된 노드 ID 가져오기
    const selectedNodeIds = getSelectedNodeIds(userId);

    if (!selectedNodeIds || selectedNodeIds.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No documents selected for update. Please select documents first.",
      });
      return;
    }

    // 문서 업데이트 정보 가져오기
    const documentUpdates = getStoredDocumentUpdates(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No document updates found. Please try suggesting updates first.",
      });
      return;
    }

    // 선택된 노드에 해당하는 업데이트만 필터링
    const selectedUpdates = documentUpdates.filter((update: DocumentUpdate) =>
      selectedNodeIds.includes(update.nodeId)
    );

    if (selectedUpdates.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No updates found for selected documents. Please try selecting different documents.",
      });
      return;
    }

    // GitHub 서비스 인스턴스 가져오기
    const githubService = GithubService.getInstance();

    // 각 문서 업데이트 처리
    for (const update of selectedUpdates) {
      try {
        // GitHub URL에서 owner와 repo 추출
        const githubUrl = update.githubUrl;
        const [owner, repo] = githubUrl
          .replace("https://github.com/", "")
          .split("/");

        // 파일 업데이트
        await githubService.updateMarkdownFile({
          owner,
          repo,
          path: update.fileName,
          content: update.updatedNodeContent,
          message: `Update ${update.fileName} based on Slack discussion`,
        });

        console.log(`Successfully updated ${update.fileName}`);
      } catch (error) {
        console.error(`Error updating ${update.fileName}:`, error);
      }
    }

    // 성공 메시지 전송
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Selected document updates have been applied to GitHub successfully.",
    });
  } catch (error) {
    console.error("Error applying updates to GitHub:", error);

    if (body.channel?.id) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: `An error occurred while applying updates to GitHub: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }
};

export { applySelectedToGithubAction };
