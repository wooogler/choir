import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockAction,
  UsersSelectAction,
} from "@slack/bolt";
import { DocumentUpdate, getStoredDocumentUpdates, getSelectedNodeIds, updateDocTreeWithChanges } from "services/document";
import GithubService from "services/github";
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

    // GitHub 서비스 인스턴스 가져오기
    const githubService = GithubService.getInstance();

    // 파일별로 업데이트 그룹화
    const updatesByFile = new Map<string, DocumentUpdate[]>();
    
    for (const update of selectedUpdates) {
      if (!updatesByFile.has(update.fileName)) {
        updatesByFile.set(update.fileName, []);
      }
      updatesByFile.get(update.fileName)!.push(update);
    }

    // 각 파일별로 업데이트 처리
    const successfulUpdates: string[] = [];
    const failedUpdates: string[] = [];

    for (const [fileName, fileUpdates] of updatesByFile.entries()) {
      try {
        // VectorStoreService에서 원본 파일 가져오기
        const vectorStore = VectorStoreService.getInstance();
        const markdownFile = vectorStore.getMarkdownFile(fileName);
        
        if (!markdownFile) {
          throw new Error(`파일을 찾을 수 없습니다: ${fileName}`);
        }

        // 문서 트리에 변경사항 적용하여 전체 마크다운 생성
        const updatedMarkdown = updateDocTreeWithChanges(markdownFile.tree, fileUpdates);

        // GitHub URL에서 owner와 repo 추출
        const githubUrl = fileUpdates[0].githubUrl;
        const [owner, repo] = githubUrl
          .replace("https://github.com/", "")
          .split("/");

        // 전체 파일 업데이트
        await githubService.updateMarkdownFile({
          owner,
          repo,
          path: fileName,
          content: updatedMarkdown,
          message: `Update ${fileName} based on Slack discussion`,
        });

        successfulUpdates.push(fileName);
        console.log(`Successfully updated ${fileName} with ${fileUpdates.length} changes`);
      } catch (error) {
        failedUpdates.push(fileName);
        console.error(`Error updating ${fileName}:`, error);
      }
    }

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
