import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { getLastMessageTimestamp, getProgressMessageTimestamp, deleteProgressMessageTimestamp } from "services/common";

/**
 * Handle "Cancel" button click in document update suggestions
 */
const cancelDocumentUpdatesCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
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
    if (lastMessageTs && dmChannelId) {
      try {
        // 기존 메시지를 가져와서 divider 이전 블록들 유지
        const history = await client.conversations.history({
          channel: dmChannelId,
          latest: lastMessageTs,
          inclusive: true,
          limit: 1
        });

        let preservedBlocks: any[] = [];
        let hasDivider = false;
        
        if (history.messages && history.messages.length > 0) {
          const originalMessage = history.messages[0];
          if (originalMessage.blocks) {
            // divider까지의 블록들을 찾아서 보존
            for (const block of originalMessage.blocks) {
              preservedBlocks.push(block);
              if (block.type === "divider") {
                hasDivider = true;
                break;
              }
            }
          }
        }

        if (hasDivider) {
          // divider가 있는 경우: divider 이후에 cancelled 메시지 추가
          const updatedBlocks: any[] = [
            ...preservedBlocks,
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: cancelText
              }
            }
          ];

          await client.chat.update({
            channel: dmChannelId,
            ts: lastMessageTs,
            text: "Document update suggestions",
            blocks: updatedBlocks
          });
        } else {
          // divider가 없는 경우: 전체 메시지를 cancelled 메시지로 교체
          await client.chat.update({
            channel: dmChannelId,
            ts: lastMessageTs,
            text: cancelText,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: cancelText
                }
              }
            ]
          });
        }
      } catch (error) {
        logger.error("Failed to update message with cancellation:", error);
        
        // 업데이트에 실패하면 새 메시지 전송
        await client.chat.postMessage({
          channel: dmChannelId,
          text: cancelText,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: cancelText
              }
            }
          ]
        });
      }
    } else {
      // 마지막 메시지가 없으면 새 메시지 전송
      await client.chat.postMessage({
        channel: dmChannelId,
        text: cancelText,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: cancelText
            }
          }
        ]
      });
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

export default cancelDocumentUpdatesCallback; 