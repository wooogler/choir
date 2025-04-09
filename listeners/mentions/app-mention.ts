import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  createSlackMessageWithName,
  formatSlackMessageBlock,
  type SlackMessage,
  getStoredMessages,
} from "../../services/slack-utils";

const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">) => {
  try {
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 5,
    });

    console.log("historyResult", historyResult);

    if (historyResult.messages?.length) {
      const messages = (historyResult.messages ?? []).reverse();
      const slackMessages = (
        await Promise.all(
          messages.map((msg) => createSlackMessageWithName(msg, client))
        )
      ).filter((msg): msg is SlackMessage => msg !== null);

      const messageOptions = await Promise.all(
        slackMessages.map(formatSlackMessageBlock)
      );

      // 체크박스 옵션을 Slack API 형식에 맞게 변환
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
    logger.error(error);
  }
};

export default appMentionCallback;
