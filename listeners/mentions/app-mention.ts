import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  createSlackMessageWithName,
  formatSlackMessageBlock,
  type SlackMessage,
} from "../../services/slack-utils";

const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">) => {
  try {
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 3,
    });

    console.log("historyResult", historyResult);

    if (historyResult.messages?.length) {
      const messages = (historyResult.messages ?? []).reverse();
      const slackMessages = (
        await Promise.all(
          messages.map((msg) => createSlackMessageWithName(msg, client))
        )
      ).filter((msg): msg is SlackMessage => msg !== null);
      console.log("slackMessages", slackMessages);

      const messageOptions = await Promise.all(
        slackMessages.map(formatSlackMessageBlock)
      );

      console.log("messageOptions", messageOptions);

      const messageBlocks = [
        {
          type: "input",
          element: {
            type: "checkboxes",
            action_id: "selected_messages",
            options: messageOptions,
            initial_options: messageOptions,
          },
          label: {
            type: "plain_text",
            text: "Select Messages to Save",
            emoji: true,
          },
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
    logger.error(error);
  }
};

export default appMentionCallback;
