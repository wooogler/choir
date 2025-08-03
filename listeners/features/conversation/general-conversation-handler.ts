import type { Logger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logMessageProcessing } from 'services/common/user-interaction-logger';
import { respondToGeneralConversation } from 'services/llm/chat-responder';
import {
  getGithubRepo,
  getOrganizationDescription,
  getOrganizationName,
  getUserName,
  getWorkspaceId,
} from 'services/slack'; // Added organization and github functions
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * Handles general conversation messages.
 */
export async function handleGeneralConversationMessage(
  client: WebClient,
  event: any, // TODO: Define a more specific type for the event object
  message: string,
  logger: Logger,
): Promise<boolean> {
  const startTime = Date.now();
  try {
    const userName = await getUserName(event.user, client);

    // Get workspace ID and organization information
    const workspaceId = await getWorkspaceId(client);

    // Get organization name (default to workspace name if not set)
    let organizationName = await getOrganizationName(workspaceId);
    if (!organizationName) {
      // Use workspace name as default
      const workspaceInfo = await client.auth.test();
      const teamInfo = await client.team.info();
      organizationName = teamInfo.team?.name || workspaceInfo.team || 'our organization';
    }

    // Get organization description
    const descOrg = (await getOrganizationDescription(workspaceId)) || '';

    // Get GitHub repository URL
    const repoInfo = await getGithubRepo(workspaceId);
    const URLtoGithubORWebsite = repoInfo ? repoInfo.url : '';

    // Check if the message is asking about CHOIR usage
    const lowerMessage = message.toLowerCase();
    const isUsageQuestion =
      lowerMessage.includes('how') &&
      (lowerMessage.includes('use') || lowerMessage.includes('work') || lowerMessage.includes('do')) &&
      (lowerMessage.includes('choir') || lowerMessage.includes('you'));

    const isFeatureQuestion =
      lowerMessage.includes('what') &&
      (lowerMessage.includes('can') || lowerMessage.includes('feature') || lowerMessage.includes('do'));

    let replyText;

    if (isUsageQuestion || isFeatureQuestion) {
      // Provide specific CHOIR usage instructions
      replyText = `Hi *${userName}*! 👋 I'm CHOIR, and I'm here to help you with ${organizationName}'s documents and knowledge management.

*🔍 Here's how you can use me:*

*💬 For Questions:* Ask me anything about your documents or ${organizationName}
• Example: "What's our policy on remote work?"
• Example: "How do we handle code reviews?"

*📝 For Updates:* Share new information that should be documented
• Example: "We decided to use React for the new project"
• Example: "Our deployment process now includes automated testing"

*🔧 How to reach me:*
• *In channels:* Mention me with \`@choir\` followed by your message
• *Direct message:* Send me a DM. You can add me by clicking my profile picture.

*✨ I can also help you update documents, extract knowledge from conversations, and keep your team's information organized.*

What would you like to try first?`;
    } else {
      // Use the regular general conversation responder
      replyText = await respondToGeneralConversation(
        message,
        userName || 'there',
        organizationName,
        descOrg,
        URLtoGithubORWebsite,
      );
    }

    // Add document source reference naturally if GitHub URL is available (but not for usage instructions)
    let fullReplyText = replyText;
    if (URLtoGithubORWebsite && !isUsageQuestion && !isFeatureQuestion) {
      fullReplyText += `\n\n_Based on <${URLtoGithubORWebsite}|${organizationName}'s documentation>_`;
    }

    // 원본 메시지 정보를 JSON으로 인코딩
    const messageData = JSON.stringify({
      originalMessage: message,
      userId: event.user,
      channelId: event.channel,
      messageTs: event.ts,
      threadTs: event.thread_ts,
      channelType: event.channel_type,
    });

    // Send the main response to everyone
    await client.chat.postMessage({
      channel: event.channel,
      text: fullReplyText,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: fullReplyText,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.GENERAL_RESPONSE),
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });

    // Wait 1 second, then send the correction buttons privately to the user
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await client.chat.postEphemeral({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      user: event.user,
      text: '💡 If I misunderstood your message, please click one of the buttons below:',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '💡 *If I misunderstood your message, please click one of the buttons below:*',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.EPHEMERAL_HELPER),
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '❓ This was a question',
                emoji: true,
              },
              action_id: 'handle_as_question',
              value: messageData,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '📝 This was an update request',
                emoji: true,
              },
              action_id: 'handle_as_update_request',
              value: messageData,
            },
          ],
        },
      ],
    });

    // 성공 로깅
    try {
      await logMessageProcessing(
        event.user,
        workspaceId,
        event.channel,
        event.channel_type || 'public',
        !!event.thread_ts,
        Date.now() - startTime,
        true,
        message,
        'process_general_conversation',
        {
          organizationName,
          descOrg,
          githubUrl: URLtoGithubORWebsite,
          replyTextLength: replyText.length,
          botResponse: replyText,
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging general conversation:', logError);
    }

    logger.info(`General conversation reply sent to user ${event.user} in channel ${event.channel}`);
    return true;
  } catch (error) {
    logger.error('Error in handleGeneralConversationMessage:', error);
    // 실패 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logMessageProcessing(
        event.user,
        workspaceId,
        event.channel,
        event.channel_type || 'public',
        !!event.thread_ts,
        Date.now() - startTime,
        false,
        message,
        'process_general_conversation',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging general conversation failure:', logError);
    }
    return false;
  }
}
