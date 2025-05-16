import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockAction,
  UsersSelectAction,
} from "@slack/bolt";
import {
  getStoredDocumentUpdates,
  getSelectedNodeIds,
  DocumentUpdate,
} from "services/document-store";
import {
  getWorkspaceId,
  isWorkspaceOwner,
  setupInitialManager,
  addManager as updateDocument,
} from "services/slack-utils";
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

/**
 * Handle document update action
 */
const documentUpdateCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // If user is workspace owner, set as initial manager
    const isOwner = await isWorkspaceOwner(userId, client);
    if (isOwner) {
      setupInitialManager(workspaceId, userId);
    }

    // Confirm selected user
    const selectedUser = selectedUsers.get(userId);
    if (!selectedUser) {
      // If no user is selected, send error message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "Please select a user to update document first.",
      });
      return;
    }

    // Try to update document
    const success = updateDocument(workspaceId, selectedUser, userId);

    if (success) {
      // Send success message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: `Document has been updated for <@${selectedUser}>.`,
      });

      // Refresh home view
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Refreshing home view...",
              },
            },
          ],
        },
      });

      // Send notification message
      try {
        await client.chat.postMessage({
          channel: selectedUser,
          text: `<@${userId}> has updated your document.`,
        });
      } catch (error) {
        logger.error(
          `Failed to send notification to user ${selectedUser}:`,
          error
        );
      }
    } else {
      // Send failure message
      await client.chat.postEphemeral({
        channel: body.channel?.id || body.user.id,
        user: userId,
        text: "Failed to update document. Please check if you have manager permission.",
      });
    }
  } catch (error) {
    logger.error("Error updating document:", error);
  }
};

export { selectUserCallback, documentUpdateCallback };

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
