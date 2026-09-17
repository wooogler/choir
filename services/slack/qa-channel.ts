import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { type T, createT } from '../../src/i18n';
import { DEFAULT_LOCALE } from '../../src/i18n/supported-locales';
import { tForUser, tForWorkspace } from '../i18n';
import { WorkspaceStore } from '../workspace/workspace-store';
import { getWorkspaceId } from './user-management';

const workspaceStore = new WorkspaceStore();

/** Who a privately shared Q&A is addressed to, so it can be written in their language. */
export interface PrivateMessageRecipient {
  workspaceId: string;
  userId: string;
  /** Pass it when the recipient may never have been looked up before. */
  client?: WebClient;
}

/**
 * A Q&A posted into a channel has no single reader, so it follows the
 * workspace's language. `workspaceId` is passed in when the caller already has
 * it; otherwise it is looked up from the client, the way the rest of this file
 * gets at workspace-scoped state.
 *
 * A locale is a presentation detail: if resolving it fails, the message still
 * goes out, in English.
 */
async function translatorForChannel(workspaceId?: string, client?: WebClient): Promise<T> {
  try {
    const resolved = workspaceId ?? (client ? await getWorkspaceId(client) : undefined);
    if (resolved) return await tForWorkspace(resolved);
  } catch (error) {
    Logger.error('Error resolving the workspace locale for a shared Q&A', error as Error, { workspaceId });
  }
  return createT(DEFAULT_LOCALE);
}

/**
 * A Q&A sent as a DM is read by the person it was sent to, so it follows their
 * language. A group DM has several readers and only one language: the first
 * person the sharer picked stands in for the group.
 */
async function translatorForRecipient(recipient?: PrivateMessageRecipient): Promise<T> {
  if (!recipient) return createT(DEFAULT_LOCALE);
  try {
    return await tForUser(recipient.workspaceId, recipient.userId, recipient.client);
  } catch (error) {
    Logger.error('Error resolving a recipient locale for a private Q&A', error as Error, {
      userId: recipient.userId,
    });
    return createT(DEFAULT_LOCALE);
  }
}

// When no Q&A channel is configured and no #qna exists, getQAChannel would scan
// conversations.list on EVERY question (a Tier-2, ~20/min rate-limited call).
// Throttle that negative scan per workspace.
const qaChannelScanAt = new Map<string, number>();
const QA_CHANNEL_SCAN_THROTTLE_MS = 10 * 60 * 1000;
const QA_CHANNEL_SCAN_MAX_PAGES = 20;

/**
 * Q&A 채널을 설정합니다.
 */
export async function setQAChannel(workspaceId: string, channelId: string): Promise<void> {
  try {
    await workspaceStore.setQAChannel(workspaceId, channelId);
    Logger.info('Q&A channel set successfully', { workspaceId, channelId });
  } catch (error) {
    Logger.error('Error setting Q&A channel', error as Error, { workspaceId, channelId });
    throw error;
  }
}

/**
 * Q&A 채널 정보를 가져옵니다.
 */
export async function getQAChannel(workspaceId: string, client?: WebClient): Promise<string | undefined> {
  try {
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    let qaChannelId = config?.qaChannel;

    if (!qaChannelId && client) {
      const lastScan = qaChannelScanAt.get(workspaceId);
      if (lastScan && Date.now() - lastScan < QA_CHANNEL_SCAN_THROTTLE_MS) {
        // Scanned recently and found nothing; don't hammer conversations.list.
        return undefined;
      }
      qaChannelScanAt.set(workspaceId, Date.now());

      try {
        let cursor: string | undefined;
        for (let page = 0; page < QA_CHANNEL_SCAN_MAX_PAGES; page += 1) {
          const channelsList = await client.conversations.list({
            types: 'public_channel',
            exclude_archived: true,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });

          const qnaChannel = channelsList.channels?.find((channel) => channel.name === 'qna' && !channel.is_archived);
          if (qnaChannel?.id) {
            await setQAChannel(workspaceId, qnaChannel.id);
            qaChannelId = qnaChannel.id;
            qaChannelScanAt.delete(workspaceId); // found & persisted; no need to throttle
            Logger.info('Default Q&A channel found and set', { workspaceId, channelId: qnaChannel.id });
            break;
          }

          cursor = channelsList.response_metadata?.next_cursor || undefined;
          if (!cursor) break;
        }
      } catch (error) {
        Logger.error('Error finding default qna channel', error as Error, { workspaceId });
      }
    }

    return qaChannelId;
  } catch (error) {
    Logger.error('Error getting Q&A channel', error as Error, { workspaceId });
    return undefined;
  }
}

/**
 * 채널 ID로부터 클릭 가능한 채널 멘션을 생성합니다.
 */
export async function getChannelName(channelId: string, client: WebClient): Promise<string> {
  try {
    // Handle DM channels (channel IDs starting with 'D')
    if (channelId.startsWith('D')) {
      return 'DM';
    }

    const channelInfo = await client.conversations.info({ channel: channelId });
    return channelInfo.channel?.name ? `<#${channelId}|${channelInfo.channel.name}>` : 'this channel';
  } catch (error) {
    Logger.error('Error getting channel name', error as Error, { channelId });

    // Check if this might be a group DM that failed to fetch
    if (error && typeof error === 'object' && 'data' in error) {
      const slackError = error as any;
      if (slackError.data?.error === 'channel_not_found' || slackError.data?.error === 'missing_scope') {
        // This might be a group DM with C-prefix that we can't access
        return 'DM';
      }
    }

    return 'this channel';
  }
}

/**
 * Q&A 채널용 메시지를 생성합니다
 */
export async function createQAChannelMessage(
  channelName: string,
  questionerId: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  questionerName?: string,
  userComment?: string,
  client?: WebClient,
  workspaceId?: string,
) {
  const t = await translatorForChannel(workspaceId, client);
  const teamMember = t('qa.share.sender.teamMember');
  const senderIdentity = isAnonymous ? teamMember : questionerName ? `*${questionerName}*` : teamMember;
  const blocks: any[] = [];

  if (!canAnswer) {
    const introBlock: any = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('qa.share.channel.intro', { channelName, sender: senderIdentity, question }),
      },
      block_id: createCHOIRBlockId(CHOIRMessageType.QA_SHARE_INTRO_UNANSWERED),
    };

    // Add user profile image (real profile for non-anonymous, default for anonymous)
    if (!isAnonymous && questionerId && client) {
      try {
        const userInfo = await client.users.info({ user: questionerId });
        if (userInfo.user?.profile?.image_192) {
          introBlock.accessory = {
            type: 'image',
            image_url: userInfo.user.profile.image_192,
            alt_text: questionerName || t('qa.share.image.alt.profile'),
          };
        } else {
          // Fallback to default profile image
          introBlock.accessory = {
            type: 'image',
            image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
            alt_text: questionerName || t('qa.share.image.alt.profile'),
          };
        }
      } catch (error) {
        Logger.error('Error fetching user profile image', error as Error, { questionerId });
        // Fallback to default profile image on error
        introBlock.accessory = {
          type: 'image',
          image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
          alt_text: questionerName || t('qa.share.image.alt.profile'),
        };
      }
    } else if (isAnonymous) {
      // Add default anonymous profile image
      introBlock.accessory = {
        type: 'image',
        image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: t('qa.share.image.alt.anonymous'),
      };
    }

    blocks.push(introBlock, {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('qa.share.channel.unanswered'),
      },
    });
  } else {
    const introBlock: any = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: t('qa.share.channel.intro', { channelName, sender: senderIdentity, question }),
      },
      block_id: createCHOIRBlockId(CHOIRMessageType.QA_SHARE_INTRO_ANSWERED),
    };

    // Add user profile image (real profile for non-anonymous, default for anonymous)
    if (!isAnonymous && questionerId && client) {
      try {
        const userInfo = await client.users.info({ user: questionerId });
        if (userInfo.user?.profile?.image_192) {
          introBlock.accessory = {
            type: 'image',
            image_url: userInfo.user.profile.image_192,
            alt_text: questionerName || t('qa.share.image.alt.profile'),
          };
        } else {
          // Fallback to default profile image
          introBlock.accessory = {
            type: 'image',
            image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
            alt_text: questionerName || t('qa.share.image.alt.profile'),
          };
        }
      } catch (error) {
        Logger.error('Error fetching user profile image', error as Error, { questionerId });
        // Fallback to default profile image on error
        introBlock.accessory = {
          type: 'image',
          image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
          alt_text: questionerName || t('qa.share.image.alt.profile'),
        };
      }
    } else if (isAnonymous) {
      // Add default anonymous profile image
      introBlock.accessory = {
        type: 'image',
        image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: t('qa.share.image.alt.anonymous'),
      };
    }

    blocks.push(
      introBlock,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.share.response', { response }),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.share.channel.discuss', {
            sender: isAnonymous ? t('qa.share.sender.theTeamMember') : senderIdentity,
          }),
        },
        block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
      },
    );
  }

  // Add user comment if provided
  if (userComment && userComment.trim()) {
    blocks.push(
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.share.comment', {
            author: isAnonymous ? t('qa.share.sender.theTeamMember') : questionerName || teamMember,
            comment: userComment,
          }),
        },
        block_id: createCHOIRBlockId(CHOIRMessageType.USER_COMMENT),
      },
    );
  }

  return blocks;
}

/**
 * Q&A 채널용 미리보기 텍스트를 생성합니다
 */
export async function createQAChannelPreview(
  channelName: string,
  questionerId: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  questionerName?: string,
  userComment?: string,
  workspaceId?: string,
): Promise<string> {
  const t = await translatorForChannel(workspaceId);
  const senderIdentity = isAnonymous
    ? t('qa.share.sender.anonymous')
    : questionerName || t('qa.share.sender.teamMember');
  let preview = '';

  if (!canAnswer) {
    preview = t('qa.share.channel.preview.unanswered', { channelName, sender: senderIdentity, question });
  } else {
    preview = t('qa.share.channel.preview.answered', {
      channelName,
      sender: senderIdentity,
      question,
      response,
    });
  }

  // Add user comment if provided
  if (userComment && userComment.trim()) {
    preview += `\n\n${t('qa.share.comment', { author: senderIdentity, comment: userComment })}`;
  }

  return preview;
}

/**
 * 개인 메시지용 블록을 생성합니다
 */
export async function createPrivateMessage(
  recipientId: string,
  questionerId: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  questionerName?: string,
  sessionId?: string,
  userComment?: string,
  recipient?: PrivateMessageRecipient,
) {
  const t = await translatorForRecipient(recipient);
  const teamMember = t('qa.share.sender.teamMember');
  const senderIdentity = isAnonymous ? teamMember : questionerName || teamMember;

  const blocks: any[] = [];

  if (!canAnswer) {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.intro', { sender: senderIdentity }),
        },
        ...(isAnonymous && { block_id: createCHOIRBlockId(CHOIRMessageType.ANONYMOUS_QUESTION) }),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.question', { question }),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.unanswered'),
        },
      },
    );
  } else {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.intro', { sender: senderIdentity }),
        },
        ...(isAnonymous && { block_id: createCHOIRBlockId(CHOIRMessageType.ANONYMOUS_QUESTION) }),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.question', { question }),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.share.response', { response }),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.discuss', { sender: senderIdentity }),
        },
      },
    );
  }

  // Add user comment if provided
  if (userComment && userComment.trim()) {
    blocks.push(
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.share.comment', {
            author: isAnonymous ? t('qa.share.sender.theTeamMember') : questionerName || teamMember,
            comment: userComment,
          }),
        },
        block_id: createCHOIRBlockId(CHOIRMessageType.USER_COMMENT),
      },
    );
  }

  // Anonymous 질문인 경우 실시간 전달 안내 메시지 추가
  if (isAnonymous && sessionId) {
    blocks.push(
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: t('qa.private.anonymousReplyHint'),
        },
      },
    );
  }

  return blocks;
}

/**
 * 개인 메시지용 미리보기 텍스트를 생성합니다
 */
export async function createPrivateMessagePreview(
  recipientName: string,
  questionerName: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  userComment?: string,
  recipient?: PrivateMessageRecipient,
): Promise<string> {
  const t = await translatorForRecipient(recipient);
  const senderIdentity = isAnonymous ? t('qa.share.sender.anonymous') : questionerName;
  let preview = '';

  if (!canAnswer) {
    preview = t('qa.private.preview.unanswered', { sender: senderIdentity, question });
  } else {
    preview = t('qa.private.preview.answered', { sender: senderIdentity, question, response });
  }

  // Add user comment if provided
  if (userComment && userComment.trim()) {
    preview += `\n\n${t('qa.share.comment', { author: senderIdentity, comment: userComment })}`;
  }

  return preview;
}
