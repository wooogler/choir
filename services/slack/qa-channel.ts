import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { WorkspaceStore } from '../workspace/workspace-store';

const workspaceStore = new WorkspaceStore();

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
      try {
        const channelsList = await client.conversations.list({
          types: 'public_channel',
          exclude_archived: true,
        });

        const qnaChannel = channelsList.channels?.find((channel) => channel.name === 'qna' && !channel.is_archived);

        if (qnaChannel?.id) {
          await setQAChannel(workspaceId, qnaChannel.id);
          qaChannelId = qnaChannel.id;
          Logger.info('Default Q&A channel found and set', { workspaceId, channelId: qnaChannel.id });
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
) {
  const senderIdentity = isAnonymous ? 'A team member' : (questionerName ? `*${questionerName}*` : 'A team member');
  const blocks: any[] = [];

  if (!canAnswer) {
    const introBlock: any = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hi, #${channelName} - ${senderIdentity} asked the following question and this was my response.\n\n*Question:*\n${question}`,
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
            alt_text: questionerName || 'User profile',
          };
        } else {
          // Fallback to default profile image
          introBlock.accessory = {
            type: 'image',
            image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
            alt_text: questionerName || 'User profile',
          };
        }
      } catch (error) {
        Logger.error('Error fetching user profile image', error as Error, { questionerId });
        // Fallback to default profile image on error
        introBlock.accessory = {
          type: 'image',
          image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
          alt_text: questionerName || 'User profile',
        };
      }
    } else if (isAnonymous) {
      // Add default anonymous profile image
      introBlock.accessory = {
        type: 'image',
        image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: 'Anonymous user',
      };
    }

    blocks.push(
      introBlock,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `However, I was not able to answer the question. Could anyone help?`,
        },
      },
    );
  } else {
    const introBlock: any = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hi, #${channelName} - ${senderIdentity} asked the following question and this was my response.\n\n*Question:*\n${question}`,
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
            alt_text: questionerName || 'User profile',
          };
        } else {
          // Fallback to default profile image
          introBlock.accessory = {
            type: 'image',
            image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
            alt_text: questionerName || 'User profile',
          };
        }
      } catch (error) {
        Logger.error('Error fetching user profile image', error as Error, { questionerId });
        // Fallback to default profile image on error
        introBlock.accessory = {
          type: 'image',
          image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
          alt_text: questionerName || 'User profile',
        };
      }
    } else if (isAnonymous) {
      // Add default anonymous profile image
      introBlock.accessory = {
        type: 'image',
        image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: 'Anonymous user',
      };
    }

    blocks.push(
      introBlock,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*My response:*\n${response}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${isAnonymous ? 'The team member' : senderIdentity} would like to discuss this response with others. Could anyone help?`,
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
          text: `*${isAnonymous ? 'The team member' : (questionerName || 'A team member')} added:*\n${userComment}`,
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
export function createQAChannelPreview(
  channelName: string,
  questionerId: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  questionerName?: string,
  userComment?: string,
): string {
  const senderIdentity = isAnonymous ? 'Anonymous user' : questionerName || 'A team member';
  let preview = '';

  if (!canAnswer) {
    preview = `Hi, #${channelName}\n${senderIdentity} asked the following question and this was my response.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\nHowever, I was not able to answer the question. Could anyone help?`;
  } else {
    preview = `Hi, #${channelName}\n${senderIdentity} asked the following question and this was my response.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\n*My response:*\n\`\`\`${response}\`\`\`\n\nHowever, ${senderIdentity} wants to discuss this with others. Could anyone help?`;
  }

  // Add user comment if provided
  if (userComment && userComment.trim()) {
    preview += `\n\n*${senderIdentity} added:*\n${userComment}`;
  }

  return preview;
}

/**
 * 개인 메시지용 블록을 생성합니다
 */
export function createPrivateMessage(
  recipientId: string,
  questionerId: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  questionerName?: string,
  sessionId?: string,
  userComment?: string,
) {
  const senderIdentity = isAnonymous ? 'A team member' : questionerName || 'A team member';

  const blocks: any[] = [];

  if (!canAnswer) {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hi there!\n${senderIdentity} asked me the following question and shared my response with you.`,
        },
        ...(isAnonymous && { block_id: createCHOIRBlockId(CHOIRMessageType.ANONYMOUS_QUESTION) }),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Question:*\n${question}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `However, I was not able to answer the question. The team member would like your help with this question.`,
        },
      },
    );
  } else {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hi there!\n${senderIdentity} asked me the following question and shared my response with you.`,
        },
        ...(isAnonymous && { block_id: createCHOIRBlockId(CHOIRMessageType.ANONYMOUS_QUESTION) }),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Question:*\n${question}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*My response:*\n${response}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${senderIdentity} would like to discuss this with you. Could you help them?`,
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
          text: `*${isAnonymous ? 'The team member' : (questionerName || 'A team member')} added:*\n${userComment}`,
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
          text: '💬 *Want to reply to the questioner?*\nSimply respond in this thread! Your replies will be automatically forwarded to the anonymous questioner.',
        },
      },
    );
  }

  return blocks;
}

/**
 * 개인 메시지용 미리보기 텍스트를 생성합니다
 */
export function createPrivateMessagePreview(
  recipientName: string,
  questionerName: string,
  question: string,
  response: string,
  canAnswer: boolean,
  isAnonymous?: boolean,
  userComment?: string,
): string {
  const senderIdentity = isAnonymous ? 'Anonymous user' : questionerName;
  let preview = '';

  if (!canAnswer) {
    preview = `Hi there!\n${senderIdentity} asked me the following question and shared my response with you.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\nHowever, I was not able to answer the question. The team member would like your help with this question.`;
  } else {
    preview = `Hi there!\n${senderIdentity} asked me the following question and shared my response with you.\n\n*Question:*\n\`\`\`${question}\`\`\`\n\n*My response:*\n\`\`\`${response}\`\`\`\n\nThe team member would like to discuss this with you. Could you help them?`;
  }

  // Add user comment if provided
  if (userComment && userComment.trim()) {
    preview += `\n\n*${senderIdentity} added:*\n${userComment}`;
  }

  return preview;
}
