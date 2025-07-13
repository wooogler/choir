import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { anonymizeText, getAnonymizationMapping } from 'services/common/name-cache';
import { getUserName, isBotUser } from 'services/slack';
import { CHOIRMessageType, EXCLUDE_FROM_HISTORY, SESSION_START_TYPES, type CHOIRMessageMetadata, getCHOIRMessageTypeFromBlocks } from 'types/message-types';

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
  metadata?: CHOIRMessageMetadata;
  [key: string]: any;
}

// Process message text to handle user and bot mentions
export async function processMessageText(text: string, client: WebClient): Promise<string> {
  // Regular expression to find all user/bot mentions like <@U089Q1VAB3J>
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let matches;
  let processedText = text;

  // Get current bot user ID
  const authResult = await client.auth.test();
  const currentBotId = authResult.user_id;

  // Collect all unique user IDs mentioned in the text
  const mentionedIds = new Set<string>();
  while ((matches = mentionRegex.exec(text)) !== null) {
    mentionedIds.add(matches[1]);
  }

  // Process each unique user ID
  for (const userId of mentionedIds) {
    const isBot = await isBotUser(userId, client);

    if (isBot) {
      if (userId === currentBotId) {
        // Replace current chatbot mention with @CHOIR
        processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '@CHOIR');
      } else {
        // Remove other bot mentions completely
        processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '');
      }
    } else {
      // Replace user mentions with anonymized names
      const userName = await getUserName(userId, client);
      const anonymizationMapping = getAnonymizationMapping(userId, userName);
      processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), anonymizationMapping.fakeNickname);
    }
  }

  // Apply general text anonymization for any remaining real names
  const anonymizedText = anonymizeText(processedText);

  return anonymizedText.trim();
}

// Process message history with filtering and mention processing
export const processMessageHistory = async (messages: any[], client?: WebClient) => {
  // First, find session boundaries using metadata
  let sessionStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.metadata?.messageType && SESSION_START_TYPES.includes(msg.metadata.messageType)) {
      sessionStartIndex = i;
      break;
    }
  }

  // Take only messages from the current session
  const currentSessionMessages = messages.slice(sessionStartIndex);

  const filteredMessages = currentSessionMessages.filter((msg) => {
    // Basic filters
    if (!msg.text || msg.subtype) return false;

    // Filter out messages based on metadata message type
    if (msg.metadata?.messageType) {
      return !EXCLUDE_FROM_HISTORY.includes(msg.metadata.messageType);
    }

    // Filter out messages based on block_id message type
    if (msg.blocks && msg.blocks.length > 0) {
      const blockMessageType = getCHOIRMessageTypeFromBlocks(msg.blocks);
      if (blockMessageType) {
        return !EXCLUDE_FROM_HISTORY.includes(blockMessageType);
      }
    }

    // Fallback: Filter out loading messages and status messages from bots (for backward compatibility)
    if (msg.bot_id) {
      const excludePatterns = [
        // Loading messages
        'Searching relevant documents',
        'Preparing document update suggestions',
        'Processing knowledge and generating',
        ':mag:',
        ':brain:',
        'Extracting knowledge from',
        'Analyzing conversation',
        'Analyzing recent messages to extract knowledge',
        'let me know this was actually a question',
        'clarified this was a suggestion for updating our docs',
        ':thinking_face:',
        ':memo:',
        // Status messages to exclude
        '✅ Analyzed',
        'messages to extract knowledge',
        'Sure! I\'ll suggest the following update to',
        'I\'ll suggest the following update to',
      ];

      // Filter out messages matching exclude patterns
      const shouldExclude = excludePatterns.some((pattern) => msg.text.includes(pattern));
      return !shouldExclude;
    }

    // Keep all user messages
    return true;
  });

  // Process mentions if client is provided
  const processedMessages = client
    ? await Promise.all(
        filteredMessages.map(async (msg) => ({
          ...msg,
          text: await processMessageText(msg.text, client),
        })),
      )
    : filteredMessages;

  return await Promise.all(
    processedMessages.map(async (msg) => {
      const role = msg.bot_id ? 'CHOIR' : 'user';
      let content = msg.text;

      if (msg.bot_id) {
        // For bot messages, add CHOIR: prefix
        content = `CHOIR: ${msg.text}`;
      } else if (msg.user && client) {
        // For user messages, format as "Username: message"
        // Handle case where msg.user might be the string "undefined"
        if (msg.user === 'undefined') {
          content = `Unknown User: ${msg.text}`;
        } else {
          const userName = await getUserName(msg.user, client);
          const anonymizationMapping = getAnonymizationMapping(msg.user, userName);
          content = `${anonymizationMapping.fakeNickname}: ${msg.text}`;
        }
      }

      return {
        role,
        content,
      };
    }),
  );
};

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

        const threadMessages = (threadResult.messages || []) as SlackMessage[];
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
      } catch (error) {
        Logger.warn('Failed to get thread reference timestamp, using current time', error as Error);
        referenceTimestamp = Date.now();
      }
    }

    const timeLimitAgo = Math.floor((referenceTimestamp - timeLimit * 60 * 1000) / 1000);
    const now = Math.floor(Date.now() / 1000);

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

      const threadMessages = (threadResult.messages || []) as SlackMessage[];

      // 2. Get conversation history before the parent message (thread_ts)
      const parentTimestamp = Number.parseFloat(event.thread_ts);
      const preThreadResult = await client.conversations.history({
        channel: event.channel,
        latest: event.thread_ts, // Stop at the parent message
        limit: Math.ceil(adjustedLimit / 2), // Use remaining half for pre-thread context
        ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
      });

      const preThreadMessages = (preThreadResult.messages || []).filter((msg: any) => {
        if (!msg.ts) return false;
        const msgTimestamp = Number.parseFloat(msg.ts);
        return msgTimestamp < parentTimestamp; // Exclude the parent message to avoid duplication
      }) as SlackMessage[];

      // 3. Combine pre-thread conversation + thread messages (chronological order)
      messages = [...preThreadMessages.reverse(), ...threadMessages];
    } else {
      // Non-thread mentions: use regular channel history
      const historyResult = await client.conversations.history({
        channel: event.channel,
        limit: adjustedLimit,
        ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
      });

      messages = (historyResult.messages || []) as SlackMessage[];

    }

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

    // Sort by timestamp and limit results
    const sortedMessages = [...messages].sort((a, b) => {
      const tsA = Number.parseFloat(a.ts || '0');
      const tsB = Number.parseFloat(b.ts || '0');
      return tsA - tsB;
    });

    const finalMessages = sortedMessages.slice(-maxResults);


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
