import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { processMessageText } from 'services/llm/qa-service';

export interface ConversationHistoryOptions {
  timeLimit?: number; // minutes
  messageLimit?: number;
  maxResults?: number;
}

export interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  thread_ts?: string;
  [key: string]: any;
}

/**
 * Get filtered conversation history excluding Non-CHOIR users
 */
export async function getFilteredConversationHistory(
  client: WebClient,
  event: any,
  choirUsers: string[],
  options: ConversationHistoryOptions = {},
): Promise<SlackMessage[]> {
  // Use extended time limit and message counts for thread replies when not explicitly specified
  const defaultTimeLimit = event.thread_ts ? 1440 : 5; // 24 hours for thread replies, 5 minutes for regular mentions
  const defaultMessageLimit = event.thread_ts ? 20 : 10; // More messages for thread context
  const defaultMaxResults = event.thread_ts ? 15 : 5; // Return more results for thread context

  const { timeLimit = defaultTimeLimit, messageLimit = defaultMessageLimit, maxResults = defaultMaxResults } = options;

  try {
    let referenceTimestamp = Date.now(); // Default to current time

    // For thread replies, find the timestamp of the message just before the mention
    if (event.thread_ts) {
      try {
        // Get thread messages to find the message before the current mention
        const threadResult = await client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: 50, // Get enough messages to find the previous one
          inclusive: true,
        });

        const threadMessages = threadResult.messages || [];
        const currentMentionTs = event.ts;

        // Find the message just before the mention message
        let previousMessage = null;
        for (let i = 0; i < threadMessages.length; i++) {
          if (threadMessages[i].ts === currentMentionTs && i > 0) {
            previousMessage = threadMessages[i - 1];
            break;
          }
        }

        // Use the previous message timestamp, or parent message if this is the first reply
        if (previousMessage && previousMessage.ts) {
          referenceTimestamp = Number.parseFloat(previousMessage.ts) * 1000;
        } else {
          // If no previous message, use parent message timestamp
          referenceTimestamp = Number.parseFloat(event.thread_ts) * 1000;
        }

        Logger.debug('Thread reference timestamp calculation', {
          currentMentionTs,
          previousMessageTs: previousMessage?.ts,
          parentTs: event.thread_ts,
          selectedReferenceTs: Math.floor(referenceTimestamp / 1000),
        });
      } catch (error) {
        Logger.warn('Failed to get thread reference timestamp, using current time', error as Error);
        referenceTimestamp = Date.now();
      }
    }

    const timeLimitAgo = Math.floor((referenceTimestamp - timeLimit * 60 * 1000) / 1000);
    const now = Math.floor(Date.now() / 1000);

    Logger.debug('Getting conversation history', {
      channel: event.channel,
      thread_ts: event.thread_ts,
      timeLimit,
      messageLimit,
      maxResults,
      timeLimitAgo,
      currentTime: now,
      referenceTime: event.thread_ts ? 'previous_message' : 'current_time',
      referenceTimestamp: Math.floor(referenceTimestamp / 1000),
      timeDiffMinutes: (Math.floor(referenceTimestamp / 1000) - timeLimitAgo) / 60,
    });

    // Get conversation history or replies
    // For longer time limits, get more messages without oldest filter to ensure we get recent messages
    const adjustedLimit = timeLimit > 60 ? messageLimit * 5 : messageLimit; // Increase limit for longer time periods

    let messages: SlackMessage[] = [];

    if (event.thread_ts) {
      // For thread mentions, get both thread messages AND conversation before the parent message

      // 1. Get thread messages (including parent message)
      const threadResult = await client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: Math.ceil(adjustedLimit / 2), // Use half the limit for thread messages
        inclusive: true,
        ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
      });

      const threadMessages = threadResult.messages || [];

      Logger.debug('Thread messages retrieved', {
        threadMessageCount: threadMessages.length,
        threadMessages: threadMessages.map((msg) => ({
          ts: msg.ts,
          user: msg.user,
          text: msg.text?.substring(0, 100) + '...',
          timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
        })),
      });

      // 2. Get conversation history before the parent message (thread_ts)
      const parentTimestamp = Number.parseFloat(event.thread_ts);
      const preThreadResult = await client.conversations.history({
        channel: event.channel,
        latest: event.thread_ts, // Stop at the parent message
        limit: Math.ceil(adjustedLimit / 2), // Use remaining half for pre-thread context
        ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
      });

      Logger.debug('Pre-thread raw messages retrieved', {
        preThreadRawCount: preThreadResult.messages?.length || 0,
        parentTimestamp,
        parentTimestampISO: new Date(parentTimestamp * 1000).toISOString(),
        preThreadRawMessages: (preThreadResult.messages || []).map((msg) => ({
          ts: msg.ts,
          user: msg.user,
          text: msg.text?.substring(0, 100) + '...',
          timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
          isBeforeParent: msg.ts ? Number.parseFloat(msg.ts) < parentTimestamp : false,
        })),
      });

      const preThreadMessages = (preThreadResult.messages || []).filter((msg: SlackMessage) => {
        if (!msg.ts) return false;
        const msgTimestamp = Number.parseFloat(msg.ts);
        return msgTimestamp < parentTimestamp; // Exclude the parent message to avoid duplication
      });

      Logger.debug('Pre-thread messages after parent filter', {
        preThreadFilteredCount: preThreadMessages.length,
        preThreadFilteredMessages: preThreadMessages.map((msg) => ({
          ts: msg.ts,
          user: msg.user,
          text: msg.text?.substring(0, 100) + '...',
          timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
        })),
      });

      // 3. Combine pre-thread conversation + thread messages (chronological order)
      messages = [...preThreadMessages.reverse(), ...threadMessages];

      Logger.debug('Thread context enhanced', {
        preThreadCount: preThreadMessages.length,
        threadCount: threadMessages.length,
        totalCount: messages.length,
        threadTs: event.thread_ts,
        timeLimitHours: timeLimit / 60,
        isExtendedContext: timeLimit > 60,
        timeLimitAgoISO: new Date(timeLimitAgo * 1000).toISOString(),
        referenceTimestampISO: new Date(Math.floor(referenceTimestamp / 1000) * 1000).toISOString(),
      });
    } else {
      // Non-thread mentions: use regular channel history
      const historyResult = await client.conversations.history({
        channel: event.channel,
        limit: adjustedLimit,
        ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
      });

      messages = historyResult.messages || [];
    }

    Logger.debug('Raw messages from Slack API', {
      messageCount: messages.length,
      messages: messages.map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
      })),
    });

    if (messages.length === 0) {
      return [];
    }

    // Filter messages within time limit
    const beforeTimeFilter = messages.length;
    const rejectedByTimeFilter: any[] = [];

    messages = messages.filter((msg: SlackMessage) => {
      if (!msg.ts) {
        rejectedByTimeFilter.push({ msg, reason: 'no_timestamp' });
        return false;
      }
      const messageTime = Number.parseFloat(msg.ts);
      const isWithinTimeLimit = messageTime >= timeLimitAgo;

      if (!isWithinTimeLimit) {
        rejectedByTimeFilter.push({
          msg: {
            ts: msg.ts,
            user: msg.user,
            text: msg.text?.substring(0, 50) + '...',
            timestamp: new Date(messageTime * 1000).toISOString(),
          },
          reason: 'outside_time_limit',
          messageTime,
          timeLimitAgo,
          timeDiff: (messageTime - timeLimitAgo) / 3600, // hours
        });
      }

      return isWithinTimeLimit;
    });

    Logger.debug('After time filter', {
      beforeCount: beforeTimeFilter,
      afterCount: messages.length,
      rejectedCount: rejectedByTimeFilter.length,
      timeLimitAgoISO: new Date(timeLimitAgo * 1000).toISOString(),
      rejectedMessages: rejectedByTimeFilter,
      remainingMessages: messages.map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
      })),
    });

    // Filter out Non-CHOIR users (exclude messages from users not in choirUsers list)
    // Keep messages from bots and CHOIR users only
    const beforeChoirFilter = messages.length;
    const rejectedByChoirFilter: any[] = [];

    messages = messages.filter((msg: SlackMessage) => {
      // Always include bot messages
      if (msg.bot_id) return true;

      // Include messages from CHOIR users
      if (msg.user && choirUsers.includes(msg.user)) return true;

      // Exclude messages from Non-users
      rejectedByChoirFilter.push({
        msg: {
          ts: msg.ts,
          user: msg.user,
          text: msg.text?.substring(0, 50) + '...',
          timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
        },
        reason: 'not_choir_user',
        isInChoirUsers: msg.user ? choirUsers.includes(msg.user) : false,
      });

      return false;
    });

    Logger.debug('After CHOIR user filter', {
      beforeCount: beforeChoirFilter,
      afterCount: messages.length,
      rejectedCount: rejectedByChoirFilter.length,
      choirUsersCount: choirUsers.length,
      choirUsers,
      rejectedMessages: rejectedByChoirFilter,
      remainingMessages: messages.map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        bot_id: msg.bot_id,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
        isChoirUser: msg.user ? choirUsers.includes(msg.user) : false,
      })),
    });

    // Sort by timestamp and limit results
    const beforeSortAndLimit = messages.length;
    const sortedMessages = [...messages].sort((a, b) => {
      const tsA = Number.parseFloat(a.ts || '0');
      const tsB = Number.parseFloat(b.ts || '0');
      return tsA - tsB;
    });

    const finalMessages = sortedMessages.slice(-maxResults);
    const droppedByLimit = sortedMessages.slice(0, -maxResults);

    Logger.debug('Final sorted and limited messages', {
      beforeLimitCount: beforeSortAndLimit,
      afterSortCount: sortedMessages.length,
      maxResults,
      finalCount: finalMessages.length,
      droppedByLimitCount: droppedByLimit.length,
      droppedMessages: droppedByLimit.map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 50) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
      })),
      finalMessages: finalMessages.map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
      })),
    });

    // Process mentions in message text to replace user IDs with names
    const processedMessages = await Promise.all(
      finalMessages.map(async (msg) => {
        if (msg.text) {
          const processedText = await processMessageText(msg.text, client);
          return { ...msg, text: processedText };
        }
        return msg;
      }),
    );

    Logger.debug('After mention processing', {
      messageCount: processedMessages.length,
      messages: processedMessages.map((msg) => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp',
      })),
    });

    Logger.debug('Filtered conversation history', {
      originalCount: messages.length || 0,
      filteredCount: processedMessages.length,
      choirUsersCount: choirUsers.length,
      timeLimit,
      messageLimit,
      maxResults,
    });

    return processedMessages;
  } catch (error) {
    Logger.error('Error getting filtered conversation history', error as Error, {
      channel: event.channel,
      thread_ts: event.thread_ts,
      timeLimit,
      messageLimit,
      maxResults,
    });
    return [];
  }
}

/**
 * Check if user is a CHOIR user (authorized to use CHOIR features)
 */
export function isCHOIRUser(userId: string, choirUsers: string[]): boolean {
  return choirUsers.includes(userId);
}
