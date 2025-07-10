import type { WebClient } from '@slack/web-api';

export enum ChannelType {
  GENERAL_CHANNEL = 'general_channel',
  QA_CHANNEL = 'qa_channel', 
  ONE_ON_ONE_DM = 'one_on_one_dm',
  GROUP_DM = 'group_dm'
}

export interface ChannelClassification {
  type: ChannelType;
  displayName: string;
  timeLimit: number; // in minutes
  description: string;
}

/**
 * Get detailed channel information using Slack API
 */
async function getChannelInfo(channelId: string, client: WebClient) {
  try {
    const result = await client.conversations.info({ channel: channelId });
    if (result.ok && result.channel) {
      return result.channel as any;
    }
    return null;
  } catch (error) {
    console.warn('Failed to get channel info:', error);
    return null;
  }
}

/**
 * Classify channel type for CHOIR knowledge extraction
 * @param channelId - The channel ID to classify
 * @param client - Slack WebClient
 * @param qaChannelId - Optional Q&A channel ID for comparison
 * @returns Promise<ChannelClassification> - Channel classification with timeLimit
 */
export async function classifyChannel(
  channelId: string, 
  client: WebClient,
  qaChannelId?: string
): Promise<ChannelClassification> {
  const channelInfo = await getChannelInfo(channelId, client);
  
  // Check if it's the Q&A channel
  if (qaChannelId && channelId === qaChannelId) {
    return {
      type: ChannelType.QA_CHANNEL,
      displayName: 'Q&A Channel',
      timeLimit: 4320, // 3 days
      description: 'Designated Q&A channel for team questions'
    };
  }
  
  // Check if it's a DM using API info
  if (channelInfo) {
    if (channelInfo.is_im === true) {
      return {
        type: ChannelType.ONE_ON_ONE_DM,
        displayName: '1:1 Direct Message',
        timeLimit: 4320, // 3 days
        description: 'One-on-one conversation with CHOIR'
      };
    }
    
    if (channelInfo.is_mpim === true) {
      return {
        type: ChannelType.GROUP_DM,
        displayName: 'Group Direct Message', 
        timeLimit: 4320, // 3 days
        description: 'Group conversation including CHOIR'
      };
    }
  }
  
  // Fallback: check by channel ID pattern for DMs
  if (channelId.startsWith('D')) {
    return {
      type: ChannelType.ONE_ON_ONE_DM,
      displayName: '1:1 Direct Message',
      timeLimit: 4320, // 3 days  
      description: 'One-on-one conversation with CHOIR (detected by ID pattern)'
    };
  }
  
  // Some group DMs might start with G or even C
  if (channelInfo && (channelInfo.is_group || channelInfo.is_private) && 
      (channelInfo.num_members || 0) <= 10) { // Small group, likely a group DM
    return {
      type: ChannelType.GROUP_DM,
      displayName: 'Group Direct Message',
      timeLimit: 4320, // 3 days
      description: 'Small group conversation including CHOIR'
    };
  }
  
  // Default: general channel
  return {
    type: ChannelType.GENERAL_CHANNEL,
    displayName: 'General Channel',
    timeLimit: 10, // 10 minutes
    description: 'Regular team channel'
  };
}

/**
 * Check if a channel is a DM (Direct Message) using Slack API
 * @param channelId - The channel ID to check
 * @param client - Slack WebClient
 * @returns Promise<boolean> - true if it's a DM (1:1 or group), false otherwise
 */
export async function isDMByAPI(channelId: string, client: WebClient): Promise<boolean> {
  const classification = await classifyChannel(channelId, client);
  return classification.type === ChannelType.ONE_ON_ONE_DM || 
         classification.type === ChannelType.GROUP_DM;
}

/**
 * Check if a channel is a DM (Direct Message)
 * @param channelId - The channel ID to check
 * @param channelType - Optional channel type from event
 * @returns true if it's a DM (1:1 or group), false otherwise
 */
export function isDM(channelId: string, channelType?: string): boolean {
  // Use channel_type if available (most reliable)
  if (channelType) {
    return channelType === 'im' || channelType === 'mpim';
  }
  
  // Fallback to channel ID pattern
  // D* = 1:1 DM, G* can be group DM or private channel, C* can also be group DM in some cases
  return channelId.startsWith('D') || channelId.startsWith('G');
}

/**
 * Check if a channel is a 1:1 DM (Direct Message)
 * @param channelId - The channel ID to check
 * @param channelType - Optional channel type from event
 * @returns true if it's a 1:1 DM, false otherwise
 */
export function is1to1DM(channelId: string, channelType?: string): boolean {
  // Use channel_type if available (most reliable)
  if (channelType) {
    return channelType === 'im';
  }
  
  // Fallback to channel ID pattern
  return channelId.startsWith('D');
}

/**
 * Check if a channel is a group DM (Multi-party Direct Message)
 * @param channelId - The channel ID to check
 * @param channelType - Optional channel type from event
 * @returns true if it's a group DM, false otherwise
 */
export function isGroupDM(channelId: string, channelType?: string): boolean {
  // Use channel_type if available (most reliable)
  if (channelType) {
    return channelType === 'mpim';
  }
  
  // Fallback to channel ID pattern (less reliable as G* can also be private channels)
  return channelId.startsWith('G');
}

// Legacy utilities that don't fit into other modules
export function createGitbookSectionLink(sectionName: string, fileName?: string): string {
  if (!sectionName) return '';

  if (!fileName) {
    return `https://choir.gitbook.io/echolab-assets/#${sectionName.toLowerCase().replace(/\s+/g, '-')}`;
  }

  const formattedFileName = fileName.replace(/\.md$/, '').toLowerCase().replace(/\s+/g, '_');

  const formattedSectionName = sectionName.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '.').replace(/-/g, '-');

  return `https://choir.gitbook.io/echolab-assets/${formattedFileName}#${formattedSectionName}`;
}
