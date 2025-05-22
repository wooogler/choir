import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { getStoredMessages, formatSlackMessageBlock } from "services/slack";
import suggestUpdatesCallback from "../../document-handlers/suggest-updates";

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
}

/**
 * 메시지 선택 액션 처리
 */
export async function handleSelectMessages({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) {
  await ack();

  try {
    const userId = body.user.id;
    const dmChannelId = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!dmChannelId || !messageTs) {
      throw new Error("Channel ID or message timestamp not found");
    }

    // Parse value
    const rawValue = body.actions[0].value;
    const parsedValue = JSON.parse(rawValue ?? "{}");
    const { originalChannelId, originalThreadTs } = parsedValue;

    // Get checkbox state
    const blockId = Object.keys(body.state?.values ?? {})[0];
    const selectedOptions = body.state?.values?.[blockId]?.check_messages?.selected_options;

    if (!selectedOptions || !Array.isArray(selectedOptions)) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "Please select messages to proceed.",
      });
      return;
    }

    // Get selected message keys
    const messageKeys = selectedOptions.map((option) => option.value);
    const validMessages = getStoredMessages(messageKeys);

    if (validMessages.length === 0) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "Selected messages not found.",
      });
      return;
    }

    // Create blocks for selected messages
    const selectedMessagesBlocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Document Update",
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Messages to Update Document*"
        }
      }
    ];
    
    // Add each selected message to the block
    for (const message of validMessages) {
      const formattedBlock = await formatSlackMessageBlock(message);
      selectedMessagesBlocks.push({
        type: "section",
        text: formattedBlock.text
      });
    }
    
    // Add divider at the end
    selectedMessagesBlocks.push({
      type: "divider"
    } as SlackBlock);

    // Update message (without document update proposal button)
    await client.chat.update({
      channel: dmChannelId,
      ts: messageTs,
      text: "Selected messages",
      blocks: selectedMessagesBlocks
    });

    // Start document update proposal process immediately
    await suggestUpdatesCallback({
      ack: async () => {},
      body: {
        user: { id: userId },
        channel: { id: dmChannelId },
        actions: [
          {
            value: JSON.stringify({
              messageKeys,
              originalChannelId,
              originalThreadTs,
              action: "generate_updates"
            })
          }
        ],
        container: { thread_ts: originalThreadTs }
      },
      client
    } as any);

  } catch (error) {
    console.error("Error processing message selection:", error);
    
    // Send error message
    const channelId = body.channel?.id;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Error processing message selection: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      });
    }
  }
}