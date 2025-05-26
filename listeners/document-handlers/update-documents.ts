import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockAction,
  UsersSelectAction,
} from "@slack/bolt";
import { DocumentUpdate, getStoredDocumentUpdates, getSelectedNodeIds } from "services/document";
import { applyDocumentUpdatesToGithub } from "services/github";
import { VectorStoreService } from "services/vector/main-service";

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
    const rawValue = body.actions[0].value;
    if (!rawValue) {
      throw new Error("No value provided");
    }

    const value = JSON.parse(rawValue);
    const userId = value.userId || body.user.id;
    const channelId = body.channel?.id;

    if (!channelId) {
      throw new Error("채널 ID를 찾을 수 없습니다");
    }

    // 저장된 모든 document updates 가져오기 (더 이상 selectedNodeIds 필요 없음)
    const documentUpdates = getStoredDocumentUpdates(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No document updates found. Please try suggesting updates first.",
      });
      return;
    }

    console.log(`Found ${documentUpdates.length} document updates for user ${userId}`);

    // 모든 업데이트 사용 (선택된 노드 필터링 제거)
    const selectedUpdates = documentUpdates;

    // GitHub에 문서 업데이트 적용
    const results = await applyDocumentUpdatesToGithub({
      userId,
      documentUpdates: selectedUpdates,
      client,
    });

    // 결과 분석
    const successfulUpdates = results.filter(r => r.success).map(r => r.fileName);
    const failedUpdates = results.filter(r => !r.success).map(r => r.fileName);

    // 결과 메시지 생성
    let resultMessage = "";
    if (successfulUpdates.length > 0) {
      resultMessage += `✅ Successfully updated ${successfulUpdates.length} file(s):\n${successfulUpdates.map(f => `• ${f}`).join('\n')}`;
    }
    if (failedUpdates.length > 0) {
      if (resultMessage) resultMessage += "\n\n";
      resultMessage += `❌ Failed to update ${failedUpdates.length} file(s):\n${failedUpdates.map(f => `• ${f}`).join('\n')}`;
    }

    // 결과 메시지 전송
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: resultMessage || "Document update process completed.",
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
