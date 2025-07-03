import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';

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

    // Get conversation history or replies
    const historyResult = event.thread_ts
      ? await client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: messageLimit,
          inclusive: true,
          oldest: timeLimitAgo.toString(),
        })
      : await client.conversations.history({
          channel: event.channel,
          limit: messageLimit,
          oldest: timeLimitAgo.toString(),
        });

    let messages = historyResult.messages || [];

    if (messages.length === 0) {
      return [];
    }

    // Filter messages within time limit
    messages = messages.filter((msg: SlackMessage) => {
      if (!msg.ts) return false;
      const messageTime = Number.parseFloat(msg.ts);
      return messageTime >= timeLimitAgo;
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

    // Sort by timestamp and limit results
    const sortedMessages = [...messages]
      .sort((a, b) => {
        const tsA = Number.parseFloat(a.ts || '0');
        const tsB = Number.parseFloat(b.ts || '0');
        return tsA - tsB;
      })
      .slice(-maxResults);

    Logger.debug('Filtered conversation history', {
      originalCount: historyResult.messages?.length || 0,
      filteredCount: sortedMessages.length,
      choirUsersCount: choirUsers.length,
      timeLimit,
      messageLimit,
      maxResults
    });

    return sortedMessages;
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

/**
 * Get standardized Non-user response message with manager list and consent form URL
 */
export async function getNonUserResponseMessage(managers: string[], consentFormUrl?: string): Promise<string> {
  const managerMentions = managers.map(id => `<@${id}>`).join(', ');
  
  const consentSection = consentFormUrl 
    ? `2. *Complete the research consent form* - <${consentFormUrl}|Click here to access the consent form>`
    : '2. *Complete the research consent form* - your manager will provide you with the consent form link';

  return `Hi there! 👋 

I'd love to help you, but it looks like you're not currently registered as a CHOIR user. CHOIR is part of a research study designed to help teams manage and access their collective knowledge more effectively.

To start using CHOIR, you'll need to:
1. *Contact a workspace manager* - ${managerMentions} can add you to the CHOIR user list
${consentSection}

*Why join?* CHOIR can help you quickly find answers from your team's documentation, get contextual responses to questions, and contribute to advancing research on AI-powered collaboration tools.

If you're interested in participating, please reach out to one of your workspace managers who can guide you through the process. We'd be happy to have you as part of our research community! 🎓✨

_Note: Your messages and interactions are not being recorded or used for research purposes until you officially join as a CHOIR user._`;
}