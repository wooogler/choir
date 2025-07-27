import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { Logger } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { Block, KnownBlock } from '@slack/web-api';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { getUserName } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import suggestUpdatesCallback from '../suggestions/suggest-updates';

/**
 * Handle "Apply Updates" button click
 */
export const applyExtractedKnowledgeCallback = async ({
  ack,
  body,
  client,
  logger,
  context,
  next,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const sessionId = body.actions[0].value;

    if (!sessionId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Invalid session. Please try the knowledge extraction again.',
      });
      return;
    }

    // Get session data
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Session data not found. Please try the knowledge extraction again.',
      });
      return;
    }

    // ========== CONCURRENCY CONTROL ==========
    const managerId = body.user.id;
    
    // 1. Check if already being processed by another manager
    if (sessionData.status === 'processing') {
      const processingManagerName = sessionData.processingManagerName || 'Another manager';
      
      // Use response_url to immediately show conflict message
      try {
        if (body.response_url) {
          await fetch(body.response_url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              replace_original: true,
              text: `❌ Already being processed by ${processingManagerName}`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `❌ *Already being processed*\n\n${processingManagerName} is currently handling this suggestion. Please wait for them to complete the process.`,
                  },
                },
              ],
            }),
          });
        }
      } catch (responseError) {
        logger.warn('Failed to send conflict message via response_url:', responseError);
      }
      
      logger.info(`Manager ${managerId} tried to process session ${sessionId} but it's already being processed by ${sessionData.processingBy}`);
      return;
    }

    // 2. Claim processing (atomic operation)
    const managerName = await getUserName(managerId, client);
    sessionData.status = 'processing';
    sessionData.processingBy = managerId;
    sessionData.processingManagerName = managerName;
    sessionData.processingAt = new Date().toISOString();
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);
    
    logger.info(`Manager ${managerName} (${managerId}) claimed processing for session ${sessionId}`);

    // 3. Update current manager with processing confirmation via response_url
    try {
      if (body.response_url) {
        await fetch(body.response_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            replace_original: true,
            text: '✅ Processing started!',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '✅ *Processing started!*\n🔄 Generating document suggestions...',
                },
              },
            ],
          }),
        });
      }
    } catch (responseError) {
      logger.warn('Failed to send processing confirmation via response_url:', responseError);
    }

    // 4. Update other managers' messages to show conflict state
    await updateOtherManagerMessages(sessionData, managerId, managerName, client, logger);
    
    // 5. Notify original channel about who started processing
    await notifyOriginalChannel(sessionData, managerName, client, logger);
    // ========== END CONCURRENCY CONTROL ==========

    // Get team_id and bot_id for the slack:// URL
    const authInfo = await client.auth.test();

    const teamId = authInfo.team_id;
    const botUserId = authInfo.user_id;

    if (!teamId || !botUserId) {
      logger.error('Failed to get team_id or user_id for DM link');
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Could not create a link to DM. Please try again or contact support.',
      });
      return;
    }

    // Check if this is already a DM conversation
    const isDMConversation = sessionData.originalChannelId?.startsWith('D');

    // Only send processing messages if this is NOT a DM conversation
    if (!isDMConversation) {
      // Send public notification to channel
      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
        text: '🔄 Processing knowledge and generating document updates...',
        blocks: [
          {
            block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '🔄 Manager is processing the knowledge and generating document updates...',
            },
          },
        ],
      });

      // Show ephemeral processing message with DM button
      await client.chat.postEphemeral({
        channel: sessionData.originalChannelId,
        ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
        user: body.user.id,
        text: '🔄 Processing knowledge and generating document updates...',
        blocks: [
          {
            block_id: createCHOIRBlockId(CHOIRMessageType.EPHEMERAL_HELPER),
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '🔄 Processing knowledge and generating document updates...\nDocument suggestions will be sent to your DM.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button' as const,
                text: {
                  type: 'plain_text' as const,
                  text: 'Open DM',
                  emoji: true,
                },
                style: 'primary' as const,
                url: `slack://user?team=${teamId}&id=${botUserId}&tab=messages`,
              },
            ],
          },
        ],
      });
    }

    // Use all messages as source messages
    let sourceMessages = sessionData.messages || [];

    // Update session data with source messages for easier access
    sessionData.sourceMessages = sourceMessages;
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

    // suggestUpdatesCallback 호출 시 body를 원본 body에서 필요한 부분만 가져오도록 수정
    // 또한, suggestUpdatesCallback이 SlackActionMiddlewareArgs<BlockButtonAction> 타입을 정확히 받도록
    // 호출하는 곳에서 필요한 모든 속성을 제공해야 함.
    // 여기서는 body.actions[0].value 를 파싱하여 필요한 값을 직접 전달하는 형태로 변경.
    const suggestUpdatesValue = {
      originalChannelId: sessionData.originalChannelId,
      originalThreadTs: sessionData.originalThreadTs,
      sessionId: sessionId,
    };

    await suggestUpdatesCallback({
      ack: async () => {},
      body: {
        ...body, // 원본 body의 다른 속성들 (trigger_id, container 등)을 유지
        actions: [
          {
            ...body.actions[0],
            value: JSON.stringify(suggestUpdatesValue),
          },
        ],
        user: { id: sessionData.userId },
        channel: { id: body.user.id },
      },
      client,
      logger,
      context, // context 전달
      next, // next 전달
    } as AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>); // 타입 캐스팅은 유지하되, 실제 필요한 모든 속성을 전달하도록 함

    logger.info(`Knowledge applied for session ${sessionId}`);
  } catch (error) {
    logger.error('Error applying extracted knowledge:', error);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to apply knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
};

/**
 * Update other managers' messages to show that processing has started by another manager
 */
async function updateOtherManagerMessages(
  sessionData: any,
  currentManagerId: string,
  currentManagerName: string,
  client: WebClient,
  logger: Logger,
): Promise<void> {
  if (!sessionData.managerMessageInfo) {
    logger.warn('No managerMessageInfo found in session data');
    return;
  }

  const updatePromises = Object.entries(sessionData.managerMessageInfo)
    .filter(([managerId]) => managerId !== currentManagerId)
    .map(async ([managerId, messageInfo]: [string, any]) => {
      try {
        const blocks: (KnownBlock | Block)[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Hi there! I'm CHOIR, your friendly documentation assistant. 👋\n\n*${sessionData.userName || 'A team member'}* has a suggestion for updating our documents, and I'm helping to pass it along for review.`,
            },
          },
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '📝 Document Update Suggestion',
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*From:* *${sessionData.userName || 'Unknown User'}*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Suggestion:*\n\`\`\`${sessionData.extractedKnowledge || 'No content available'}\`\`\``,
            },
          },
        ];

        if (sessionData.originalMessageLink) {
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
            },
          });
        }

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Processing started by ${currentManagerName}*\n~~This suggestion is now being processed.~~`,
          },
        });

        await client.chat.update({
          channel: messageInfo.channel,
          ts: messageInfo.ts,
          text: `✅ Processing started by ${currentManagerName}`,
          blocks,
        });
        logger.info(`Updated message for manager ${managerId} - processing started by ${currentManagerName}`);
      } catch (error) {
        logger.warn(`Failed to update message for manager ${managerId}:`, error);
      }
    });

  await Promise.allSettled(updatePromises);
}

/**
 * Notify the original channel that processing has started and by whom
 */
async function notifyOriginalChannel(
  sessionData: any,
  managerName: string,
  client: WebClient,
  logger: Logger,
): Promise<void> {
  if (!sessionData.originalChannelId) {
    logger.warn('No originalChannelId found in session data - skipping channel notification');
    return;
  }

  try {
    await client.chat.postMessage({
      channel: sessionData.originalChannelId,
      thread_ts: sessionData.originalThreadTs,
      text: `🔄 ${managerName} started processing your document update suggestion.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔄 *${managerName}* started processing your document update suggestion. You'll receive the document suggestions in your DM shortly! 📝`,
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    logger.info(`Notified original channel ${sessionData.originalChannelId} that ${managerName} started processing`);
  } catch (error) {
    logger.warn(`Failed to notify original channel ${sessionData.originalChannelId}:`, error);
  }
}
