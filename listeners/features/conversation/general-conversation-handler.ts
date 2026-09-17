import type { Logger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logMessageProcessing } from 'services/common/interaction-tracker';
import { SessionType, generateSessionId, storeSessionData } from 'services/common/session-store';
import { type Locale, resolveLocaleForUserCached } from 'services/i18n';
import { respondToGeneralConversation } from 'services/llm/chat-responder';
import {
  getGithubRepo,
  getOrganizationDescription,
  getOrganizationName,
  getUserName,
  getWorkspaceId,
} from 'services/slack'; // Added organization and github functions
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { createT } from '../../../src/i18n';
import { buildClarifyPromptBlocks } from './shared';

/**
 * Handles general conversation messages.
 *
 * `locale` is the asker's language, handed down by the router from Bolt's
 * `context`. It is optional because the router is not the only possible caller;
 * without it the asker's locale is resolved from cache instead, which stays off
 * the network.
 */
export async function handleGeneralConversationMessage(
  client: WebClient,
  event: any, // TODO: Define a more specific type for the event object
  message: string,
  logger: Logger,
  locale?: Locale,
): Promise<boolean> {
  const startTime = Date.now();
  try {
    const userName = await getUserName(event.user, client);

    // Get workspace ID and organization information
    const workspaceId = await getWorkspaceId(client);

    const t = createT(locale ?? (await resolveLocaleForUserCached(workspaceId, event.user)));

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

    let replyText: string;

    if (isUsageQuestion || isFeatureQuestion) {
      // Provide specific CHOIR usage instructions
      replyText = t('conversation.usageGuide.body', { userName, organizationName });
    } else {
      // Use the regular general conversation responder
      replyText = await respondToGeneralConversation(
        message,
        userName || 'there',
        organizationName,
        descOrg,
        URLtoGithubORWebsite,
        workspaceId,
      );
    }

    // Add document source reference naturally if GitHub URL is available (but not for usage instructions)
    let fullReplyText = replyText;
    if (URLtoGithubORWebsite && !isUsageQuestion && !isFeatureQuestion) {
      const label = t('conversation.link.documentation', { organizationName });
      fullReplyText += `\n\n${t('conversation.reply.source', {
        documentationLink: `<${URLtoGithubORWebsite}|${label}>`,
      })}`;
    }

    // 원본 메시지 정보를 세션에 저장 (Slack 버튼 value 2000자 제한 우회)
    const sessionId = generateSessionId('general_conv');
    storeSessionData(
      sessionId,
      {
        // workspaceId lets purgeWorkspaceSessions clean this up on uninstall.
        workspaceId,
        originalMessage: message,
        userId: event.user,
        channelId: event.channel,
        messageTs: event.ts,
        threadTs: event.thread_ts,
        channelType: event.channel_type,
      },
      SessionType.GENERAL_CONVERSATION,
      24 * 60 * 60 * 1000, // 24시간 후 만료
    );

    // Send the main response, staying in the thread the user asked in (otherwise
    // the reply lands at the channel root, detached from the question).
    await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
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
      text: t('conversation.clarifyPrompt.fallback'),
      blocks: buildClarifyPromptBlocks({
        t,
        sessionId,
        blockId: createCHOIRBlockId(CHOIRMessageType.EPHEMERAL_HELPER),
      }),
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
