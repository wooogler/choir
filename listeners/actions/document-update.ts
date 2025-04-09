import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockAction,
  UsersSelectAction,
} from "@slack/bolt";
import { VectorStoreService } from "../../services/index";
import {
  getStoredDocumentUpdates,
  getStoredThreadTs,
  getSelectedNodeIds,
  clearSelectedNodeIds,
} from "../../services/document-store";
import { applySelectedToGithub } from "../../services/github";
import { SlackMessage } from "services/slack-utils";
import {
  getWorkspaceId,
  isWorkspaceOwner,
  setupInitialManager,
  addManager as updateDocument,
} from "../../services/slack-utils";

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
export const applySelectedToGithubAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const channelId = body.channel?.id;
    const value = body.actions[0].value;
    const parsedValue = JSON.parse(value || "{}");

    // Handle validMessages exception
    let validMessages: SlackMessage[] = [];
    try {
      if (
        parsedValue.validMessages &&
        Array.isArray(parsedValue.validMessages)
      ) {
        validMessages = parsedValue.validMessages;
      } else {
        console.warn(
          "Valid message array is missing or has invalid format:",
          parsedValue.validMessages
        );
      }
    } catch (error) {
      console.error("Error parsing validMessages:", error);
    }

    if (!channelId) {
      throw new Error("Channel ID not found");
    }

    // Get node IDs selected by user
    const selectedNodeIdsArray = getSelectedNodeIds(userId);

    // No documents selected
    if (selectedNodeIdsArray.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No documents selected. Please select documents to update.",
      });
      return;
    }

    // Get stored document updates
    const documentUpdates = getStoredDocumentUpdates(userId);
    const thread_ts = getStoredThreadTs(userId);

    // Send update in progress message (displayed in comment thread)
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: thread_ts,
      text: "Updating selected documents to GitHub...",
    });

    // Create VectorStoreService instance
    const vectorStore = VectorStoreService.getInstance();

    // Apply changes to GitHub
    const results = await applySelectedToGithub({
      userId,
      channelId,
      client,
      selectedNodeIds: selectedNodeIdsArray,
      documentUpdates,
      vectorStore,
      validMessages,
    });

    // Rebuild vector store
    await vectorStore.forceRebuildCache();

    // Send results to user
    const resultMessage =
      results.length > 0
        ? results.map((r) => r.message).join("\n")
        : "No documents selected.";

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: thread_ts,
      text: `*Document Update Results*\n\n${resultMessage}`,
    });

    // Reset selected nodes after update
    clearSelectedNodeIds(userId);
  } catch (error) {
    console.error("Error updating selected documents:", error);

    if (body.channel?.id) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: `Error occurred during document update: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  }
};
