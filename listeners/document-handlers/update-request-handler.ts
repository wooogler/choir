import { createSlackMessageWithName, formatSlackMessageBlock, formatSlackMessageSection, SlackMessage, getChannelName, isBotUser, storeMessage } from "services/slack";
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
    const isThreadMention = !!event.thread_ts;
    
    try {
      // Get bot info
      const authTest = await client.auth.test();
      const botUserId = authTest.user_id;
      const teamId = authTest.team_id;

      // 스레드에서 멘션된 경우 해당 스레드에, 아닌 경우 채널에 직접 메시지 전송
      await client.chat.postMessage({
        channel: originalChannelId,
        ...(isThreadMention && { thread_ts: event.thread_ts }),
        text: "Thank you for the request. Let's discuss the update in a separate channel.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Thank you for the request. Let's discuss the update in a separate channel."
            }
          }
        ]
      });

      // Send ephemeral message with DM shortcut
      await client.chat.postEphemeral({
        channel: originalChannelId,
        user: userId,
        ...(isThreadMention && { thread_ts: event.thread_ts }),
        text: "Please press the button below to proceed with the document update.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Please press the button below to proceed with the document update."
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Document Update",
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
    const historyResult = isThreadMention ? 
      await client.conversations.replies({
        channel: originalChannelId,
        ts: event.thread_ts,
        limit: 50, // 더 많은 메시지 가져오기
        inclusive: true // 원본 메시지 포함
      }) :
      await client.conversations.history({
        channel: originalChannelId,
        limit: 50, // 더 많은 메시지 가져오기
    });

    if (historyResult.messages?.length) {
      // 시간 순으로 정렬 (오래된 순) 및 봇 메시지 필터링
      const messages = [...(historyResult.messages ?? [])]
        .sort((a, b) => {
          const tsA = parseFloat(a.ts || '0');
          const tsB = parseFloat(b.ts || '0');
          return tsA - tsB;  // 오래된 메시지가 먼저 오도록 정렬
        });

      // 봇이 아닌 메시지만 필터링
      const nonBotMessages = await Promise.all(
        messages.map(async (msg: any) => {
          if (!msg.user) return null;
          const isBot = await isBotUser(msg.user, client);
          return isBot ? null : msg;
        })
      );

      const slackMessages = (
        await Promise.all(
          nonBotMessages
            .filter((msg): msg is any => msg !== null)
            .map((msg: any) => createSlackMessageWithName(msg, client))
        )
      ).filter((msg): msg is SlackMessage => msg !== null);


      // 전체 메시지 저장 (Load More를 위해)
      const allMessageKeys = slackMessages.map(msg => storeMessage(msg));
      
      // 시간순 정렬 상태 유지하면서 마지막 5개 선택
      const limitedSlackMessages = slackMessages.slice(-5);

      const messageOptions = await Promise.all(
        limitedSlackMessages.map(msg => formatSlackMessageBlock(msg, true))
      );

      // Convert checkbox options to Slack API format
      const checkboxOptions = messageOptions.map((option) => ({
        text: option.text,
        value: option.value,
      }));

      // Get channel name
      const channelName = await getChannelName(originalChannelId, client);

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
            text: isThreadMention ?
              `Here are recent replies in this thread from ${channelName}. Select replies to use for document update.` : 
              `Here are recent messages from ${channelName}. Select messages to use for document update.`,
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
              text: isThreadMention ?
                `Here are recent replies in this thread from ${channelName}. Click the button below to select messages for document update.` : 
                `Here are recent messages from ${channelName}. Click the button below to select messages for document update.`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Select Messages",
                },
                action_id: "open_message_selection_modal",
                value: JSON.stringify({
                  originalChannelId,
                  originalThreadTs: event.thread_ts,
                  messageKeys: messageOptions.map(option => option.value),
                  channelName,
                  currentLimit: 5,
                  allMessageKeys: allMessageKeys
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