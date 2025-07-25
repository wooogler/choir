import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { Logger } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
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

  // response_url을 통해 ephemeral 메시지를 "적용됨" 상태로 업데이트 - DISABLED
  // try {
  //   if (body.response_url) {
  //     await fetch(body.response_url, {
  //       method: 'POST',
  //       headers: {
  //         'Content-Type': 'application/json',
  //       },
  //       body: JSON.stringify({
  //         replace_original: true,
  //         text: '✅ Update applied!',
  //         blocks: [
  //           {
  //             type: 'section',
  //             text: {
  //               type: 'mrkdwn',
  //               text: '✅ *Update applied!*\nThe knowledge has been processed and applied to the documentation.',
  //             },
  //           },
  //         ],
  //       }),
  //     });
  //   }
  // } catch (error) {
  //   logger.warn('Failed to update ephemeral message via response_url:', error);
  // }

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
      knowledgeContent: sessionData.extractedKnowledge,
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
