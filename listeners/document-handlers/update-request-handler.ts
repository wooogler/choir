import { createSlackMessageWithName, formatSlackMessageBlock, SlackMessage } from "services/slack";


/**
 * 업데이트 요청 메시지 처리
 */
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

      // 체크박스 옵션 Slack API 형식으로 변환
      const checkboxOptions = messageOptions.map((option) => ({
        text: option.text,
        value: option.value,
      }));

      const messageBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*저장할 메시지 선택*",
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

      // 채널인 경우 스레드로 메시지 전송, DM인 경우 바로 전송
      await client.chat.postMessage({
        channel: event.channel,
        ...(event.channel_type !== "im" && event.ts ? { thread_ts: event.ts } : {}),
        text: `<@${event.user}>님이 CHOIR에 문서 편집을 요청했습니다.`,
      });

      // 사용자에게만 보이는 임시 메시지 전송
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user ?? "unknown",
        ...(event.channel_type !== "im" && event.ts ? { thread_ts: event.ts } : {}),
        text: "저장할 메시지를 선택해주세요.",
        blocks: [
          ...messageBlocks,
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "문서 업데이트 제안",
                },
                action_id: "suggest_updates",
              },
            ],
          },
        ],
      });

      return true;
    }
    return false;
  } catch (error) {
    logger.error("Error handling update request message:", error);
    throw error;
  }
} 