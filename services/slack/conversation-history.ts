import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
// Removed anonymization imports - now handled in LLM services
import { getUserName, isBotUser } from 'services/slack';
import {
  type CHOIRMessageMetadata,
  CHOIRMessageType,
  EXCLUDE_FROM_HISTORY,
  SESSION_END_TYPES,
  SESSION_START_TYPES,
  getCHOIRMessageTypeFromBlocks,
} from 'types/message-types';

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
      // Replace user mentions with actual user names for better readability
      const userName = await getUserName(userId, client);
      processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), `@${userName}`);
    }
  }

  // No anonymization here - return original text with mentions processed
  return processedText.trim();
}

// Helper function to get reference timestamp for thread messages - simplified
function getReferenceTimestamp(event: any): number {
  if (!event.thread_ts) {
    return Date.now();
  }
  
  // Use thread parent timestamp as reference point - no API call needed
  return Number.parseFloat(event.thread_ts) * 1000;
}

// Helper function to collect messages from Slack API - simplified for knowledge extraction
async function collectMessages(
  client: WebClient,
  event: any,
  adjustedLimit: number,
  timeLimitAgo: number,
  timeLimit: number,
): Promise<SlackMessage[]> {
  let messages: SlackMessage[] = [];

  if (event.thread_ts) {
    // For thread mentions, get only thread messages (no pre-thread context needed)
    const threadResult = await client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: adjustedLimit, // Use full limit for thread messages
      inclusive: true,
      ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
    });

    messages = (threadResult.messages || []) as SlackMessage[];
    // Thread messages already come in chronological order
  } else {
    // Non-thread mentions: use regular channel history
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: adjustedLimit,
      ...(timeLimit <= 60 ? { oldest: timeLimitAgo.toString() } : {}),
    });

    messages = (historyResult.messages || []) as SlackMessage[];
    // Slack API returns messages in reverse chronological order (newest first)
    // Reverse to get chronological order (oldest first)
    messages = messages.reverse();
  }

  return messages;
}

// Helper function to filter messages by time limit
function filterMessagesByTime(messages: SlackMessage[], timeLimitAgo: number): SlackMessage[] {
  return messages.filter((msg: SlackMessage) => {
    if (!msg.ts) return false;
    const messageTime = Number.parseFloat(msg.ts);
    return messageTime >= timeLimitAgo;
  });
}

// Helper function to filter messages by CHOIR users
function filterMessagesByUsers(messages: SlackMessage[], choirUsers: string[]): SlackMessage[] {
  return messages.filter((msg: SlackMessage) => {
    // Always include bot messages
    if (msg.bot_id) return true;
    // Include messages from CHOIR users
    if (msg.user && choirUsers.includes(msg.user)) return true;
    // Exclude messages from Non-users
    return false;
  });
}

// Helper function to debug log messages
function debugLogMessages(messages: SlackMessage[], title: string): void {
  console.log(`📋 [ConversationHistory] ${title} (${messages.length}):`);
  messages.forEach((msg, idx) => {
    const timestamp = msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'no timestamp';
    const userType = msg.bot_id ? 'BOT' : 'USER';
    const userId = msg.user || msg.bot_id || 'unknown';
    const textPreview = msg.text ? msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '') : 'no text';

    // Extract message type from metadata or blocks
    let messageType = msg.metadata?.messageType || 'UNKNOWN';
    if (messageType === 'UNKNOWN' && msg.blocks) {
      const typeFromBlocks = getCHOIRMessageTypeFromBlocks(msg.blocks);
      if (typeFromBlocks) {
        messageType = typeFromBlocks;
      }
    }

    console.log(`   ${idx + 1}. [${userType}] ${userId} @ ${timestamp}`);
    console.log(`      Type: ${messageType}`);
    console.log(`      Text: "${textPreview}"`);

    // Show blocks info for debugging
    if (msg.blocks && msg.blocks.length > 0) {
      const blockIds = msg.blocks.map((block: any) => block.block_id).filter(Boolean);
      if (blockIds.length > 0) {
        console.log(`      Block IDs: ${blockIds.join(', ')}`);
      }
    }
  });
}

// Helper function to filter messages by type
function filterMessagesByType(messages: SlackMessage[]): SlackMessage[] {
  return messages.filter((msg: SlackMessage) => {
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

    return true;
  });
}

// Helper function to find session boundaries and get messages from current session
function getMessagesAfterSessionBoundary(messages: SlackMessage[]): SlackMessage[] {
  let sessionStartIndex = -1;
  let sessionEndIndex = -1;

  // Find both session start and session end indices (searching from newest to oldest)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    let messageType = msg.metadata?.messageType;

    // Check blocks as fallback if no metadata
    if (!messageType && msg.blocks && msg.blocks.length > 0) {
      messageType = getCHOIRMessageTypeFromBlocks(msg.blocks) || undefined;
    }

    if (messageType) {
      // Find latest session start
      if (sessionStartIndex === -1 && SESSION_START_TYPES.includes(messageType)) {
        sessionStartIndex = i;
      }

      // Find latest session end (only if we haven't found one yet)
      if (sessionEndIndex === -1 && SESSION_END_TYPES.includes(messageType)) {
        sessionEndIndex = i;
      }
    }
  }

  // Priority logic:
  // 1. If we have both, use the one that comes LATER (more recent)
  // 2. Session start is inclusive, session end is exclusive (after the end message)

  if (sessionStartIndex >= 0 && sessionEndIndex >= 0) {
    // Both found - use the more recent one
    if (sessionStartIndex > sessionEndIndex) {
      // Session start is more recent - return from session start (inclusive)
      return messages.slice(sessionStartIndex);
    } else {
      // Session end is more recent - return after session end (exclusive)
      if (sessionEndIndex < messages.length - 1) {
        return messages.slice(sessionEndIndex + 1);
      } else {
        return []; // Session end is the last message, no messages after it
      }
    }
  } else if (sessionStartIndex >= 0) {
    // Only session start found
    return messages.slice(sessionStartIndex);
  } else if (sessionEndIndex >= 0) {
    // Only session end found
    if (sessionEndIndex < messages.length - 1) {
      return messages.slice(sessionEndIndex + 1);
    } else {
      return []; // Session end is the last message, no messages after it
    }
  }

  // No session boundaries found
  return messages;
}

// Process message history - Pure transformation function (no filtering)
// Input: Pre-filtered messages from getFilteredConversationHistory
// Output: LLM-ready conversation format
export const processMessageHistory = async (messages: SlackMessage[], client?: WebClient) => {
  // Process mentions if client is provided
  const processedMessages = client
    ? await Promise.all(
        messages.map(async (msg) => ({
          ...msg,
          text: await processMessageText(msg.text || '', client),
        })),
      )
    : messages;

  return await Promise.all(
    processedMessages.map(async (msg) => {
      const role = msg.bot_id ? 'CHOIR' : 'user';
      let content = msg.text || '';

      if (msg.bot_id) {
        // For bot messages, add CHOIR: prefix
        content = `CHOIR: ${msg.text || ''}`;
      } else if (msg.user && client) {
        // For user messages, format as "Username: message"
        // Handle case where msg.user might be the string "undefined"
        if (msg.user === 'undefined') {
          content = `Unknown User: ${msg.text || ''}`;
        } else {
          const userName = await getUserName(msg.user, client);
          content = `${userName}: ${msg.text || ''}`;
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
    const referenceTimestamp = getReferenceTimestamp(event);
    const timeLimitAgo = Math.floor((referenceTimestamp - timeLimit * 60 * 1000) / 1000);

    // Get conversation history or replies
    // For longer time limits, get more messages without oldest filter to ensure we get recent messages
    const adjustedLimit = timeLimit > 60 ? messageLimit * 5 : messageLimit; // Increase limit for longer time periods

    // Step 1: Collect messages from Slack API
    let messages = await collectMessages(client, event, adjustedLimit, timeLimitAgo, timeLimit);

    if (messages.length === 0) {
      return [];
    }

    // Step 2: Apply all filters
    messages = filterMessagesByTime(messages, timeLimitAgo);
    messages = filterMessagesByUsers(messages, choirUsers);
    messages = filterMessagesByType(messages);

    // Step 3: Get messages after last session boundary (session end or from latest session start)
    messages = getMessagesAfterSessionBoundary(messages);

    // Step 4: Sort by timestamp and limit results
    const sortedMessages = [...messages].sort((a, b) => {
      const tsA = Number.parseFloat(a.ts || '0');
      const tsB = Number.parseFloat(b.ts || '0');
      return tsA - tsB;
    });

    const finalMessages = sortedMessages.slice(-maxResults);

    // Debug: Show final messages being used
    debugLogMessages(finalMessages, 'Final messages being returned');

    // Step 5: Process mentions in message text to replace user IDs with names
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
