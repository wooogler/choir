import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { handleUpdateRequestMessage } from "../document-update/extract-knowledge/update-request-handler";

/**
 * Handle "This was an update request" button click
 */
export const handleAsUpdateRequestCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const actionValue = body.actions[0].value;
    if (!actionValue) {
      throw new Error("Action value is missing");
    }

    const messageData = JSON.parse(actionValue);
    
    // 원본 이벤트 객체 재구성
    const reconstructedEvent = {
      user: messageData.userId,
      channel: messageData.channelId,
      ts: messageData.threadTs,
      channel_type: messageData.channelType
    };

    // 원본 메시지를 update request로 처리
    await handleUpdateRequestMessage(client, reconstructedEvent, logger);

    // 원본 메시지 업데이트 (버튼 제거)
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    
    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: "✅ Got it! I've processed your message as an update request.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "✅ Got it! I've processed your message as an update request."
            }
          }
        ]
      });
    }

    logger.info(`Message re-processed as update request for user ${messageData.userId}`);

  } catch (error) {
    logger.error("Error handling message as update request:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to process your message as an update request: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}; 