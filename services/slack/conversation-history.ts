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
  options: ConversationHistoryOptions = {}
): Promise<SlackMessage[]> {
  const {
    timeLimit = 5, // 5 minutes by default
    messageLimit = 10, // fetch up to 10 messages
    maxResults = 5 // return up to 5 messages
  } = options;

  try {
    const timeLimitAgo = Math.floor((Date.now() - timeLimit * 60 * 1000) / 1000);
    const now = Math.floor(Date.now() / 1000);

    Logger.debug('Getting conversation history', {
      channel: event.channel,
      thread_ts: event.thread_ts,
      timeLimit,
      messageLimit,
      maxResults,
      timeLimitAgo,
      currentTime: now,
      timeDiffMinutes: (now - timeLimitAgo) / 60
    });

    // Get conversation history or replies
    // For longer time limits, get more messages without oldest filter to ensure we get recent messages
    const adjustedLimit = timeLimit > 60 ? messageLimit * 5 : messageLimit; // Increase limit for longer time periods
    
    const historyResult = event.thread_ts
      ? await client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: adjustedLimit,
          inclusive: true,
          // Don't use oldest filter for long time periods to ensure we get recent messages
          ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
        })
      : await client.conversations.history({
          channel: event.channel,
          limit: adjustedLimit,
          // Don't use oldest filter for long time periods to ensure we get recent messages  
          ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
        });

    let messages = historyResult.messages || [];

    Logger.debug('Raw messages from Slack API', {
      messageCount: messages.length,
      messages: messages.map(msg => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp'
      }))
    });

    if (messages.length === 0) {
      return [];
    }

    // Filter messages within time limit
    messages = messages.filter((msg: SlackMessage) => {
      if (!msg.ts) return false;
      const messageTime = Number.parseFloat(msg.ts);
      return messageTime >= timeLimitAgo;
    });

    Logger.debug('After time filter', {
      messageCount: messages.length,
      messages: messages.map(msg => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp'
      }))
    });

    // Filter out Non-CHOIR users (exclude messages from users not in choirUsers list)
    // Keep messages from bots and CHOIR users only
    messages = messages.filter((msg: SlackMessage) => {
      // Always include bot messages
      if (msg.bot_id) return true;
      
      // Include messages from CHOIR users
      if (msg.user && choirUsers.includes(msg.user)) return true;
      
      // Exclude messages from Non-users
      return false;
    });

    Logger.debug('After CHOIR user filter', {
      messageCount: messages.length,
      choirUsers,
      messages: messages.map(msg => ({
        ts: msg.ts,
        user: msg.user,
        bot_id: msg.bot_id,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp'
      }))
    });

    // Sort by timestamp and limit results
    const sortedMessages = [...messages]
      .sort((a, b) => {
        const tsA = Number.parseFloat(a.ts || '0');
        const tsB = Number.parseFloat(b.ts || '0');
        return tsA - tsB;
      })
      .slice(-maxResults);

    Logger.debug('Final sorted messages', {
      messageCount: sortedMessages.length,
      messages: sortedMessages.map(msg => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp'
      }))
    });

    // Process mentions in message text to replace user IDs with names
    const processedMessages = await Promise.all(
      sortedMessages.map(async (msg) => {
        if (msg.text) {
          const processedText = await processMessageText(msg.text, client);
          return { ...msg, text: processedText };
        }
        return msg;
      })
    );

    Logger.debug('After mention processing', {
      messageCount: processedMessages.length,
      messages: processedMessages.map(msg => ({
        ts: msg.ts,
        user: msg.user,
        text: msg.text?.substring(0, 100) + '...',
        timestamp: msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp'
      }))
    });

    Logger.debug('Filtered conversation history', {
      originalCount: historyResult.messages?.length || 0,
      filteredCount: processedMessages.length,
      choirUsersCount: choirUsers.length,
      timeLimit,
      messageLimit,
      maxResults
    });

    return processedMessages;
  } catch (error) {
    Logger.error('Error getting filtered conversation history', error as Error, {
      channel: event.channel,
      thread_ts: event.thread_ts,
      timeLimit,
      messageLimit,
      maxResults
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

