import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import type { SlackMessage } from 'services/slack';
import { getUserName } from './user-management';

// 메시지를 임시 저장할 Map
const messageStore = new Map<string, SlackMessage>();

export function storeMessage(message: SlackMessage): string {
  const key = `${message.userId}-${message.ts}`;
  messageStore.set(key, message);
  return key;
}

export function getMessage(key: string): SlackMessage | undefined {
  return messageStore.get(key);
}

export function removeMessage(key: string): boolean {
  return messageStore.delete(key);
}

export function getStoredMessages(keys: string[]): SlackMessage[] {
  return keys.map((key) => getMessage(key)).filter((msg): msg is SlackMessage => msg !== undefined);
}

export function extractKeysFromMessages(messages: SlackMessage[]): string[] {
  return messages.map((msg) => `${msg.userId}-${msg.ts}`);
}

export async function createSlackMessageWithName(
  message: { user?: string; bot_id?: string; text?: string; ts?: string },
  client: WebClient,
): Promise<SlackMessage | null> {
  if (!message.text || !message.ts) return null;

  // Handle bot messages
  if (message.bot_id && !message.user) {
    return {
      userId: message.bot_id,
      username: 'CHOIR',
      text: message.text,
      ts: message.ts,
    };
  }

  // Handle user messages
  if (!message.user) return null;

  const username = await getUserName(message.user, client);
  return {
    userId: message.user,
    username,
    text: message.text,
    ts: message.ts,
  };
}

export async function formatSlackMessageBlock(message: SlackMessage, truncate = true) {
  const timestamp = new Date(Number(message.ts) * 1000).toLocaleTimeString();

  const fullDisplayText = `*${message.username || '사용자'}* ${timestamp}\n${message.text}`;
  const displayText =
    truncate && fullDisplayText.length > 70 ? fullDisplayText.substring(0, 70) + '...' : fullDisplayText;

  const key = storeMessage(message);

  return {
    text: {
      type: 'mrkdwn',
      text: displayText,
    },
    value: key,
  };
}

export async function replaceUserMentions(text: string, client: WebClient): Promise<string> {
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...text.matchAll(mentionPattern)];

  let processedText = text;
  for (const mention of mentions) {
    const userId = mention[1];
    const userName = await getUserName(userId, client);
    processedText = processedText.replace(mention[0], `@${userName}`);
  }

  return processedText;
}

export async function convertUserIdsToNames(messages: SlackMessage[], client: WebClient): Promise<SlackMessage[]> {
  const result: SlackMessage[] = [];
  const anonymousCounter = new Map<string, number>();

  for (const message of messages) {
    try {
      const username = await getUserName(message.userId, client);
      result.push({
        ...message,
        username,
      });
    } catch (error) {
      Logger.error('Error converting user ID to name', error as Error, {
        userId: message.userId,
      });

      let anonymousNumber = anonymousCounter.get(message.userId) || 0;
      if (anonymousNumber === 0) {
        anonymousNumber = anonymousCounter.size + 1;
        anonymousCounter.set(message.userId, anonymousNumber);
      }

      result.push({
        ...message,
        username: `Anonymous ${anonymousNumber}`,
      });
    }
  }

  return result;
}

export async function replaceMentionsInText(text: string, client: WebClient): Promise<string> {
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...text.matchAll(mentionPattern)];

  let processedText = text;

  for (const mention of mentions) {
    const userId = mention[1];
    let username = 'Unknown';

    try {
      username = await getUserName(userId, client);
    } catch (error) {
      Logger.error('Error getting username for mention', error as Error, { userId });
    }

    processedText = processedText.replace(mention[0], `@${username}`);
  }

  return processedText;
}

export const removeDuplicateMessages = (messages: SlackMessage[]): SlackMessage[] => {
  const uniqueMessages = new Map<string, SlackMessage>();

  messages.forEach((msg) => {
    const key = `${msg.userId}-${msg.ts}-${msg.text}`;
    if (!uniqueMessages.has(key)) {
      uniqueMessages.set(key, msg);
    }
  });

  return Array.from(uniqueMessages.values()).sort(
    (a, b) => Number.parseInt(a.ts || '0') - Number.parseInt(b.ts || '0'),
  );
};

export function formatTimestampToDateString(timestamp: string): string {
  const date = new Date(Number.parseInt(timestamp) * 1000);
  return `${date.getFullYear()}-${(date.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date
    .getHours()
    .toString()
    .padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

export async function formatSlackMessageSection(message: SlackMessage) {
  const timestamp = new Date(Number(message.ts) * 1000).toLocaleString();
  const key = storeMessage(message);

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${message.username || '사용자'}* • ${timestamp}\n${message.text}`,
    },
    accessory: {
      type: 'checkboxes',
      action_id: 'select_message',
      options: [
        {
          text: {
            type: 'plain_text',
            text: 'Select',
          },
          value: key,
        },
      ],
    },
  };
}
