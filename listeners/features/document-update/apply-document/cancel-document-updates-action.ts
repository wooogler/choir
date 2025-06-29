import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { getLastMessageTimestamp, getProgressMessageTimestamp, deleteProgressMessageTimestamp } from "../../../../services/common";
import { logButtonClick } from "../../../../services/common/user-interaction-logger";
import { getWorkspaceId } from "../../../../services/slack";

/**
 * Handle "Cancel" button click in document update suggestions
 */
export const cancelDocumentUpdatesCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const userId = body.user.id;
    const value = body.actions?.[0]?.value;
    
    if (!value) {
      throw new Error("Button value not found");
    }

    const parsedValue = JSON.parse(value);
    const { originalChannelId, originalThreadTs, index, isFirstSuggestion } = parsedValue;

    // 메시지 텍스트 결정
    const isFirstCancel = isFirstSuggestion || index === 0;
    const cancelText = isFirstCancel ? 
      "❌ Cancelled" : 
      "✅ Completed";
    
    const cancelMessage = isFirstCancel ?
      "The document update process has been cancelled." :
      "Document update process completed.";

    // DM 채널 열기
    const dmResult = await client.conversations.open({
      users: userId
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error("DM 채널을 열 수 없습니다");
    }

    const dmChannelId = dmResult.channel.id;

    // 진행 중 메시지가 있다면 삭제
    const progressTs = getProgressMessageTimestamp(userId);
    if (progressTs) {
      try {
        await client.chat.delete({
          channel: dmChannelId,
          ts: progressTs
        });
        deleteProgressMessageTimestamp(userId);
      } catch (deleteError) {
        logger.error("진행 중 메시지 삭제 실패:", deleteError);
      }
    }

    // 마지막 suggestion 메시지를 "cancelled" 메시지로 업데이트
    const lastMessageTs = getLastMessageTimestamp(userId);
    if (lastMessageTs) {
      try {
        await client.chat.update({
          channel: dmChannelId,
          ts: lastMessageTs,
          text: cancelMessage,
        });
      } catch (error) {
        logger.error("마지막 메시지 업데이트 실패:", error);
      }
    }

    // 로그: 문서 업데이트 취소
    try {
      const workspaceId = await getWorkspaceId(client);
      logButtonClick(
        userId,
        workspaceId,
        dmChannelId,
        'dm',
        'cancel_document_updates',
        Date.now() - startTime,
        true,
        {
          isFirstCancel,
          originalChannelId,
          originalThreadTs
        }
      );
    } catch (logError) {
      logger.error("Failed to log button click error:", logError);
    }

    // 원본 채널에 취소 알림 (옵션)
    if (originalChannelId) {
      try {
        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: `📋 ${cancelMessage}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `📋 ${cancelMessage}`
              }
            }
          ]
        });
      } catch (error) {
        logger.error("Failed to send cancellation notification to original channel:", error);
      }
    }

    logger.info(`Document update ${isFirstCancel ? 'cancelled' : 'completed'} by user ${userId}`);

  } catch (error) {
    logger.error("Error cancelling document updates:", error);
    
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });
      
      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `❌ Failed to cancel document updates: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        });
      }
    } catch (dmError) {
      logger.error("Failed to send error message:", dmError);
    }
  }
};