import { createSlackMessageWithName, formatSlackMessageBlock, type SlackMessage } from "../../../services/slack-utils";

export async function handleUpdateRequestMessage(client: any, event: any, logger: any) {
  try {
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 5,
    });

    if (historyResult.messages?.length) {
      const messages = (historyResult.messages ?? []).reverse();
      const slackMessages = (
        await Promise.all(
          messages.map((msg: any) => createSlackMessageWithName(msg, client))
        )
      ).filter((msg): msg is SlackMessage => msg !== null);

      const messageOptions = await Promise.all(
        slackMessages.map(formatSlackMessageBlock)
      );

      // Convert checkbox options to Slack API format
      const checkboxOptions = messageOptions.map((option) => ({
        text: option.text,
        value: option.value,
      }));

      const messageBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Select Messages to Save*",
          },
        },
        {
          type: "actions",
          block_id: "message_selection",
          elements: [
            {
              type: "checkboxes",
              action_id: "selected_messages",
              options: checkboxOptions,
              initial_options: checkboxOptions,
            },
          ],
        },
      ];

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `<@${event.user}> requested CHOIR to edit the document.`,
      });

      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user ?? "unknown",
        thread_ts: event.ts,
        text: "Please select the messages you want to save.",
        blocks: [
          ...messageBlocks,
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Suggest Document Updates",
                },
                action_id: "suggest_updates",
              },
            ],
          },
        ],
      });
    }
  } catch (error) {
    logger.error("Error handling update request message:", error);
    throw error;
  }
} 