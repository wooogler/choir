import { WebClient } from '@slack/web-api';
import { Logger } from '@slack/bolt';
import { respondToGeneralConversation } from '../../../services/llm/chat-responder';
import { getUserName } from '../../../services/slack'; // Assuming getUserName is in this path

/**
 * Handles general conversation messages.
 */
export async function handleGeneralConversationMessage(
  client: WebClient,
  event: any, // TODO: Define a more specific type for the event object
  message: string,
  logger: Logger
): Promise<boolean> {
  try {
    const userName = await getUserName(event.user, client);
    const replyText = await respondToGeneralConversation(message, userName || 'there');

    // 원본 메시지 정보를 JSON으로 인코딩
    const messageData = JSON.stringify({
      originalMessage: message,
      userId: event.user,
      channelId: event.channel,
      threadTs: event.ts,
      channelType: event.channel_type
    });

    await client.chat.postMessage({
      channel: event.channel,
      ...(event.channel_type !== 'im' ? { thread_ts: event.ts } : {}),
      text: replyText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: replyText
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "💡 *If I misunderstood your message, please click one of the buttons below:*"
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❓ This was a question",
                emoji: true
              },
              action_id: "handle_as_question",
              value: messageData
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📝 This was an update request",
                emoji: true
              },
              action_id: "handle_as_update_request", 
              value: messageData
            }
          ]
        }
      ],
      unfurl_links: false,
      unfurl_media: false
    });

    logger.info(`General conversation reply sent to user ${event.user} in channel ${event.channel}`);
    return true;
  } catch (error) {
    logger.error('Error in handleGeneralConversationMessage:', error);
    // Optionally send an error message to the user
    // await client.chat.postMessage({
    //   channel: event.channel,
    //   ...(event.channel_type !== 'im' ? { thread_ts: event.ts } : {}),
    //   text: "Sorry, I encountered an error trying to chat. Please try again later.",
    // });
    return false;
  }
} 