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
import { formatSectionPathWithLinks } from "services/document/section-utils";

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
    const { originalChannelId, originalThreadTs, fileName, githubUrl, sectionName, headingPath, diffBlock } = value;

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

    // DM 채널 열기
    const dmResult = await client.conversations.open({
      users: userId
    });

    if (dmResult.ok && dmResult.channel?.id) {
      // 결과 메시지 생성 - 단일 파일이므로 간단하게 표시
      let resultMessage = "";
      if (successfulUpdates.length > 0) {
        const fileName = successfulUpdates[0];
        resultMessage = `✅ Successfully updated *${fileName}*`;
      }
      if (failedUpdates.length > 0) {
        const fileName = failedUpdates[0];
        resultMessage = `❌ Failed to update *${fileName}*`;
      }

      // DM으로 결과 메시지 전송
      await client.chat.postMessage({
        channel: dmResult.channel.id,
        text: resultMessage || "Document update process completed.",
      });

      // 성공한 경우 원본 채널에도 업데이트 내용 공유
      if (successfulUpdates.length > 0 && originalChannelId && diffBlock) {
        try {
          // 섹션 정보 포맷팅
          const sectionInfo = formatSectionPathWithLinks({
            headingPath,
            sectionName,
            githubUrl
          } as any);

          const updateBlocks = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Document Updated*\n*File:* <${githubUrl}|${fileName}>\n*Section:* ${sectionInfo}`
              }
            },
            diffBlock
          ];

          await client.chat.postMessage({
            channel: originalChannelId,
            ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
            text: `✅ Document Updated: ${fileName}`,
            blocks: updateBlocks,
            unfurl_links: false,
            unfurl_media: false
          });
        } catch (channelError) {
          console.error("Failed to post update to original channel:", channelError);
        }
      }
    }
  } catch (error) {
    console.error("Error applying updates to GitHub:", error);

    // DM 채널 열기
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });
      
      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `❌ An error occurred while updating the document: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        });
      }
    } catch (dmError) {
      console.error("Failed to send error message to DM:", dmError);
    }
  }
};

export { applySelectedToGithubAction };
