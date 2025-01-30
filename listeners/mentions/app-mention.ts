import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import VectorStoreService from "../../services/vector-store";
import { convertMarkdownToSlackText } from "../../services/markdown";
import { createDiffBlock } from "../../services/slack-diff";
import { editMarkdownWithUserMessages } from "../../services/completions";

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

    const userMessages =
      (historyResult.messages ?? [])
        .map((msg) => msg.text)
        .filter((text): text is string => text !== undefined) ?? [];

    if (userMessages.length > 0) {
      // UI 컴포넌트 생성
      const messages = (historyResult.messages ?? []).reverse();
      const messageOptions = await Promise.all(
        messages.map(async (msg) => {
          const userInfo = await client.users.info({
            user: msg.user ?? "",
          });
          const timestamp = new Date(
            Number(msg.ts) * 1000
          ).toLocaleTimeString();
          const valueText = `*<@${userInfo.user?.id}>* ${timestamp}\n${msg.text}`;
          return {
            text: {
              type: "mrkdwn",
              text: valueText,
            },
            value: valueText,
          };
        })
      );

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

      // 먼저 전체 메시지 전송
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `<@${event.user}> requested CHOIR to edit the document.`,
      });

      // 그 다음 ephemeral 메시지 전송
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
