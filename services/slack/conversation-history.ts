import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
// Removed anonymization imports - now handled in LLM services
import { getUserName, isBotUser } from 'services/slack';
import { safeSlackCall } from './rate-limit-handler';
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
export async function processMessageText(text: string, client: WebClient, botUserId?: string): Promise<string> {
  // Regular expression to find all user/bot mentions like <@U089Q1VAB3J>
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let matches;
  let processedText = text;

  // Collect all unique user IDs mentioned in the text
  const mentionedIds = new Set<string>();
  while ((matches = mentionRegex.exec(text)) !== null) {
    mentionedIds.add(matches[1]);
  }

  // No mentions: nothing to resolve, so skip all API lookups (auth.test / users.info).
  if (mentionedIds.size === 0) {
    return processedText.trim();
  }

  // Bot user ID is constant per workspace. Prefer the value passed by the caller so we
  // don't issue an auth.test() call for every message; fall back to a lookup if absent.
  const currentBotId = botUserId ?? (await client.auth.test()).user_id;

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
  // Process mentions if client is provided. Resolve the bot user ID once and reuse it
  // across messages to avoid an auth.test() call per message.
  const botUserId = client ? (await client.auth.test()).user_id : undefined;
  const processedMessages = client
    ? await Promise.all(
        messages.map(async (msg) => ({
          ...msg,
          text: await processMessageText(msg.text || '', client, botUserId),
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

    // Step 5: Process mentions in message text to replace user IDs with names.
    // Resolve the bot user ID once and reuse it across messages (avoids an auth.test per message).
    const botUserId = (await client.auth.test()).user_id;
    const processedMessages = await Promise.all(
      finalMessages.map(async (msg) => {
        if (msg.text) {
          const processedText = await processMessageText(msg.text, client, botUserId);
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

export function isUserInCHOIRList(userId: string, choirUsers: string[]): boolean {
  return choirUsers.includes(userId);
}

// ---------------------------------------------------------------------------
// Phase 2: extraction candidate gathering (gap-burst + cap + pre-parent context)
//
// Replaces the old fixed-window logic (maxResults=5, 10-min/3-day timeLimit) for the
// knowledge-extraction flow. Gathers a generous-but-bounded candidate set; the user's
// selection (Phase 3 checkbox UI) will further narrow it before extraction.
//
// Slack 2025 limits (non-Marketplace): conversations.history/replies = 1 req/min, 15
// objects per request. So: never request >15, never paginate, at most 2 conversations.*
// calls per trigger, and degrade gracefully (safeSlackCall) instead of blocking.
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number, allowZero = false): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) {
    return value;
  }
  return fallback;
}

const getGapSeconds = () => envInt('EXTRACTION_TIME_GAP_MINUTES', 30) * 60;
const getMaxLookbackSeconds = () => envInt('EXTRACTION_MAX_LOOKBACK_MINUTES', 90) * 60;
const getMaxCandidates = () => Math.min(envInt('EXTRACTION_MAX_CANDIDATE_MESSAGES', 15), 15); // Slack page cap
const getEarlyReplyThreshold = () => envInt('EXTRACTION_EARLY_REPLY_MAX', 2, true);

const tsToSeconds = (msg: SlackMessage): number => Number.parseFloat(msg.ts || '0');

/**
 * Keep only the latest contiguous "burst": walking backward from the newest message, cut at
 * the first silence gap larger than the threshold. Channel proximity is an implicit relatedness
 * signal, so this trims unrelated earlier topics. (Thread messages are NOT passed here — threading
 * is an explicit signal, so the whole thread is kept regardless of gaps.)
 */
function keepLatestBurst(messages: SlackMessage[], gapSeconds: number): SlackMessage[] {
  if (messages.length <= 1) {
    return messages;
  }

  let startIndex = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    if (tsToSeconds(messages[i]) - tsToSeconds(messages[i - 1]) > gapSeconds) {
      startIndex = i;
      break;
    }
  }

  return messages.slice(startIndex);
}

/**
 * Bound a chronological channel slice backward by lookback window, session marker, and time gap.
 * When `anchorTs` is given (e.g. the thread parent), the burst must be contiguous up TO the anchor:
 * the anchor participates in the gap check and is then dropped, so a cluster that is itself far
 * (> gap) before the anchor is treated as a different topic and excluded.
 */
function boundChannelBurst(
  messages: SlackMessage[],
  oldestAllowedSeconds: number,
  gapSeconds: number,
  anchorTs?: string,
): SlackMessage[] {
  let bounded = messages.filter((msg) => tsToSeconds(msg) >= oldestAllowedSeconds);
  bounded = getMessagesAfterSessionBoundary(bounded); // do not cross a prior session boundary

  if (anchorTs) {
    return keepLatestBurst([...bounded, { ts: anchorTs }], gapSeconds).filter((msg) => msg.ts !== anchorTs);
  }
  return keepLatestBurst(bounded, gapSeconds);
}

/**
 * Gather candidate messages for knowledge extraction.
 *
 * - Thread mention: the whole thread (explicit relatedness) + (only when the mention is "early",
 *   i.e. <= EXTRACTION_EARLY_REPLY_MAX human replies before it) a gap-bounded burst of channel
 *   messages from before the parent. Late mentions skip the pre-parent fetch in this interim
 *   (Phase 3 will fetch-and-default-uncheck instead).
 * - Non-thread mention: a gap-bounded burst of recent channel messages ending at the trigger.
 *
 * Non-CHOIR users are excluded (consent). Returns chronological, mention-resolved messages,
 * capped at EXTRACTION_MAX_CANDIDATE_MESSAGES.
 */
export async function gatherExtractionCandidates(
  client: WebClient,
  event: any,
  choirUsers: string[],
): Promise<SlackMessage[]> {
  const channel = event.channel;
  const gapSeconds = getGapSeconds();
  const lookbackSeconds = getMaxLookbackSeconds();
  const maxCandidates = getMaxCandidates();
  const referenceSeconds = event.ts ? Number.parseFloat(event.ts) : Date.now() / 1000;

  let candidates: SlackMessage[] = [];

  try {
    if (event.thread_ts) {
      // 1) Thread: include the whole thread (parent + replies), single page.
      const threadResult = await safeSlackCall(
        () => client.conversations.replies({ channel, ts: event.thread_ts, limit: maxCandidates, inclusive: true }),
        'gatherExtractionCandidates: thread replies',
      );
      const threadMessages = filterMessagesByType(
        filterMessagesByUsers((threadResult?.messages as SlackMessage[]) || [], choirUsers),
      );

      // 2) Mention position = number of human replies before the mention (bots/parent excluded).
      const humanRepliesBeforeMention = threadMessages.filter(
        (msg) => !msg.bot_id && msg.ts !== event.thread_ts && tsToSeconds(msg) < referenceSeconds,
      ).length;
      const isEarlyMention = humanRepliesBeforeMention <= getEarlyReplyThreshold();

      // 3) Early mention → prepend a gap-bounded burst of channel messages before the parent.
      if (isEarlyMention) {
        const parentSeconds = Number.parseFloat(event.thread_ts);
        const historyResult = await safeSlackCall(
          () => client.conversations.history({ channel, latest: event.thread_ts, inclusive: false, limit: maxCandidates }),
          'gatherExtractionCandidates: pre-parent history',
        );
        const preParent = boundChannelBurst(
          filterMessagesByType(filterMessagesByUsers(((historyResult?.messages as SlackMessage[]) || []).reverse(), choirUsers)),
          parentSeconds - lookbackSeconds,
          gapSeconds,
          event.thread_ts, // anchor: the pre-parent burst must be contiguous up to the parent
        );
        candidates = [...preParent, ...threadMessages];
      } else {
        candidates = threadMessages;
      }
    } else {
      // Non-thread: unified gap-burst back from the trigger, single page.
      const historyResult = await safeSlackCall(
        () => client.conversations.history({ channel, latest: event.ts, inclusive: true, limit: maxCandidates }),
        'gatherExtractionCandidates: channel history',
      );
      candidates = boundChannelBurst(
        filterMessagesByType(filterMessagesByUsers(((historyResult?.messages as SlackMessage[]) || []).reverse(), choirUsers)),
        referenceSeconds - lookbackSeconds,
        gapSeconds,
      );
    }
  } catch (error) {
    Logger.error('gatherExtractionCandidates failed', error as Error, { channel, threadTs: event.thread_ts });
    return [];
  }

  // De-duplicate by timestamp (the parent can surface in both fetches), sort chronologically, cap.
  const seen = new Set<string>();
  candidates = candidates
    .filter((msg) => msg.ts && !seen.has(msg.ts) && seen.add(msg.ts))
    .sort((a, b) => tsToSeconds(a) - tsToSeconds(b))
    .slice(-maxCandidates);

  // Resolve mentions to names. Bot id is constant, so fetch it once for the whole batch.
  const botUserId = (await client.auth.test()).user_id;
  return await Promise.all(
    candidates.map(async (msg) =>
      msg.text ? { ...msg, text: await processMessageText(msg.text, client, botUserId) } : msg,
    ),
  );
}
