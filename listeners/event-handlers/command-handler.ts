import type { SlackCommandMiddlewareArgs } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

interface SlackMessage {
  ts: string;
  bot_id?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
}

export const clearChatCommand = {
  command: '/clear-choir-chat',
  description: 'Clear chat history with CHOIR',
};

export async function handleClearChat({ command, ack, client }: SlackCommandMiddlewareArgs & { client: WebClient }) {
  await ack();

  try {
    // Get bot's user ID
    const authTest = await client.auth.test();
    const botUserId = authTest.user_id;

    // Open DM channel with the user
    const dmResult = await client.conversations.open({
      users: command.user_id,
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error('Failed to open DM channel');
    }

    const channelId = dmResult.channel.id;

    // Send initial status message
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'Starting to clear messages... This might take a few moments.',
    });

    // Get message history and process in batches
    let cursor;
    let deletedCount = 0;
    let totalMessages: SlackMessage[] = [];

    do {
      const result = await client.conversations.history({
        channel: channelId,
        cursor,
        limit: 200, // Fetch maximum allowed messages per request
      });

      if (result.messages) {
        // Process each message and its replies if exists
        for (const message of result.messages) {
          if ((message.bot_id !== undefined || message.user === botUserId) && typeof message.ts === 'string') {
            totalMessages.push(message as SlackMessage);

            // If message has replies, fetch them
            if (message.reply_count && message.reply_count > 0) {
              try {
                const repliesResult = await client.conversations.replies({
                  channel: channelId,
                  ts: message.ts,
                  limit: 200,
                });

                if (repliesResult.messages) {
                  const replyMessages = repliesResult.messages.filter(
                    (reply): reply is SlackMessage =>
                      (reply.bot_id !== undefined || reply.user === botUserId) &&
                      typeof reply.ts === 'string' &&
                      reply.ts !== message.ts, // Exclude parent message
                  );
                  totalMessages = totalMessages.concat(replyMessages);
                }
              } catch (error) {
                console.error(`Error fetching replies for message ${message.ts}:`, error);
              }
            }
          }
        }
      }

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    // Process deletion in batches of 50
    const batchSize = 50;
    const batches = [];

    for (let i = 0; i < totalMessages.length; i += batchSize) {
      const batch = totalMessages.slice(i, i + batchSize);
      batches.push(batch);
    }

    // Process each batch with a delay to avoid rate limits
    for (const batch of batches) {
      const deletePromises = batch.map((message) =>
        client.chat
          .delete({
            channel: channelId,
            ts: message.ts,
          })
          .catch((error) => {
            if (error.data?.error !== 'message_not_found') {
              console.error(`Error deleting message ${message.ts}:`, error);
            }
            return null;
          }),
      );

      const results = await Promise.allSettled(deletePromises);
      const successfulDeletes = results.filter((result) => result.status === 'fulfilled' && result.value !== null);
      deletedCount += successfulDeletes.length;

      // Add a small delay between batches to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Send completion message
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Successfully cleared ${deletedCount} messages from the chat history.`,
    });
  } catch (error) {
    console.error('Error clearing chat history:', error);

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Error clearing chat history: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}
