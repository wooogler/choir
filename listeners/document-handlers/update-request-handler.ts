import { createSlackMessageWithName, formatSlackMessageBlock, SlackMessage } from "services/slack";
import { WebClient } from "@slack/web-api";

interface MessageResult {
  ts: string;
  channel: string;
  ok: boolean;
}

/**
 * 업데이트 요청 메시지 처리
 */
export async function handleUpdateRequestMessage(client: WebClient, event: any, logger: any) {
  try {
    const userId = event.user;
    const originalChannelId = event.channel;
    const originalThreadTs = event.thread_ts || event.ts;
    
    try {
      // Get bot info
      const authTest = await client.auth.test();
      const botUserId = authTest.user_id;
      const teamId = authTest.team_id;

      // Send ephemeral message with DM shortcut
      await client.chat.postEphemeral({
        channel: originalChannelId,
        user: userId,
        thread_ts: originalThreadTs,
        text: "CHOIR has received your message. Please proceed with the document update in DM.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "CHOIR has received your message. Please proceed with the document update in DM."
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Open DM",
                  emoji: true
                },
                style: "primary",
                url: `slack://user?team=${teamId}&id=${botUserId}&tab=messages`
              }
            ]
          }
        ]
      });
    } catch (reactionError) {
      logger.warn("Failed to add reaction or send ephemeral message:", reactionError);
    }
    
    // Open DM channel
    const dmResult = await client.conversations.open({
      users: userId
    });
    
    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error("Failed to open DM channel");
    }
    
    const dmChannelId = dmResult.channel.id;
    
    // Show progress message in DM
    const progressMessage = await client.chat.postMessage({
      channel: dmChannelId,
      text: "Loading message history...",
    }) as MessageResult;

    // 스레드 메시지인 경우 replies API를 사용하여 스레드 히스토리를 가져옴
    const historyResult = event.thread_ts ? 
      await client.conversations.replies({
        channel: originalChannelId,
        ts: event.thread_ts,
        limit: 5,
        inclusive: true // 원본 메시지 포함
      }) :
      await client.conversations.history({
        channel: originalChannelId,
        limit: 5,
      });

    if (historyResult.messages?.length) {
      // 시간 순으로 정렬 (오래된 순)
      const messages = [...(historyResult.messages ?? [])].sort((a, b) => {
        const tsA = parseFloat(a.ts || '0');
        const tsB = parseFloat(b.ts || '0');
        return tsA - tsB;
      });

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
            text: "*Select Messages to Update*",
          },
        },
        {
          type: "actions",
          block_id: "message_selection",
          elements: [
            {
              type: "checkboxes",
              action_id: "check_messages",
              options: checkboxOptions,
              initial_options: checkboxOptions,
            },
          ],
        },
      ];
      
      // Delete progress message
      try {
        await client.chat.delete({
          channel: dmChannelId,
          ts: progressMessage.ts
        });
      } catch (deleteError) {
        logger.error("Failed to delete progress message:", deleteError);
      }

      // Send message selection UI in DM
      await client.chat.postMessage({
        channel: dmChannelId,
        text: "Please select messages to update the document.",
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
                action_id: "select_messages",
                value: JSON.stringify({
                  originalChannelId,
                  originalThreadTs,
                  messageTs: progressMessage.ts
                })
              },
            ],
          },
        ],
      }) as MessageResult;

      return true;
    }
    return false;
  } catch (error) {
    logger.error("Error handling update request message:", error);
    throw error;
  }
} 