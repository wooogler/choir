import type { WebClient } from '@slack/web-api';
import { SessionType, generateSessionId, storeSessionData } from 'services/common';
import { logKnowledgeExtraction, logUpdateRequestProcessing } from 'services/common/interaction-tracker';
import { extractKnowledgeFromMessages } from 'services/llm/knowledge-extractor';
import {
  type SlackMessage,
  classifyChannel,
  getCHOIRUsers,
  getChannelName,
  getFilteredConversationHistory,
  getManagerText,
  getManagers,
  getQAChannel,
  getUserName,
  getWorkspaceId,
  isManager,
} from 'services/slack';
import { createEnhancedMessage } from 'services/slack/message-text-utils';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId, getCHOIRMessageTypeFromBlocks } from 'types/message-types';

/**
 * Handle update request message with automatic knowledge extraction
 */
export async function handleUpdateRequestMessage(client: WebClient, event: any, logger: any, isFromButton = false) {
  const startTime = Date.now();
  const userId = event.user;
  const originalChannelId = event.channel;
  const isThreadMention = !!event.thread_ts;

  try {
    // Show loading message in the original channel/thread
    const loadingMessage = await client.chat.postMessage({
      channel: originalChannelId,
      ...(isThreadMention && { thread_ts: event.thread_ts }),
      text: '🔍 Analyzing recent messages to extract knowledge...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🔍 Analyzing recent messages to extract knowledge...',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    if (!loadingMessage.ts) {
      throw new Error('Failed to post loading message');
    }

    // Get workspace info and CHOIR users for filtering
    const workspaceId = await getWorkspaceId(client);
    const choirUsers = await getCHOIRUsers(workspaceId);

    // Classify channel type to determine timeLimit and context
    const qaChannelId = await getQAChannel(workspaceId, client);
    const channelClassification = await classifyChannel(originalChannelId, client, qaChannelId);

    console.log('🏷️ CHANNEL CLASSIFICATION:', {
      channelId: originalChannelId,
      type: channelClassification.type,
      displayName: channelClassification.displayName,
      timeLimit: channelClassification.timeLimit,
      description: channelClassification.description,
      choirUsersCount: choirUsers.length,
    });

    let filteredMessages: SlackMessage[];

    // Use conversation history for both button clicks and regular mentions
    const timeLimit = event.thread_ts ? 1440 : channelClassification.timeLimit; // 24 hours for threads, otherwise use classification

    filteredMessages = await getFilteredConversationHistory(client, event, choirUsers, {
      timeLimit, // Use classified timeLimit
      messageLimit: 10, // fetch up to 15 messages
      maxResults: 5, // return up to 15 messages including bot responses
    });

    if (!filteredMessages?.length) {
      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        text: '❌ No messages found to analyze.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No messages found to analyze.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });

      // 로그: 메시지가 없어서 실패한 경우
      await logUpdateRequestProcessing(
        userId,
        workspaceId,
        originalChannelId,
        event.channel_type || 'public',
        isThreadMention,
        Date.now() - startTime,
        false,
        'No messages found to analyze',
        '',
        { error: 'No messages found' },
        client,
      );

      return false;
    }

    // filteredMessages is already SlackMessage[] from getFilteredConversationHistory
    // Messages are already sorted by timestamp from getFilteredConversationHistory
    if (filteredMessages.length === 0) {
      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        text: '❌ No messages found to analyze.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No messages found to analyze.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });

      // 로그: 사용자 메시지가 없어서 실패한 경우
      const workspaceId = await getWorkspaceId(client);
      logUpdateRequestProcessing(
        userId,
        workspaceId,
        originalChannelId,
        event.channel_type || 'public',
        isThreadMention,
        Date.now() - startTime,
        false,
        'No messages found to analyze',
        '',
        { error: 'No messages found' },
      );

      return false;
    }

    try {
      // Generate session ID for this knowledge extraction
      const sessionId = generateSessionId('knowledge_extraction');

      // Get channel name for display
      const channelName = await getChannelName(originalChannelId, client);

      // Get initial extractor's display name
      const extractorInfo = await client.users.info({ user: userId });
      const extractorName =
        extractorInfo.user?.profile?.display_name ||
        extractorInfo.user?.real_name ||
        extractorInfo.user?.name ||
        'Unknown User';

      // Check if user is a manager
      const workspaceId = await getWorkspaceId(client);
      const isUserManager = await isManager(workspaceId, userId);

      // Get managers for the message
      const managers = await getManagers(workspaceId);
      const managerText = await getManagerText(workspaceId, client);

      // Get workspace configuration for organizational context
      const workspaceStore = new WorkspaceStore();
      const workspaceConfig = await workspaceStore.getWorkspaceConfig(workspaceId);

      // Use channel classification for context
      let channelType = channelClassification.displayName;
      if (event.thread_ts) {
        channelType = 'Thread Discussion';
      }
      const logChannelType: 'public' | 'private' | 'dm' =
        event.channel_type === 'private' || event.channel_type === 'dm' ? event.channel_type : 'public';

      // Check if conversation contains Q&A shared content (no longer needed as separate flag)
      // Q&A context is now handled directly in extractKnowledgeFromMessages

      // Build organizational context
      const organizationalContext = {
        organizationName: workspaceConfig?.organizationName,
        organizationDescription: workspaceConfig?.organizationDescription,
        isUserManager,
        managerText,
        channelType,
        extractorName,
      };

      // Extract knowledge from messages with organizational context
      const extractionResult = await extractKnowledgeFromMessages(
        filteredMessages,
        organizationalContext,
        client,
        workspaceId,
      );

      if (!extractionResult.cleanContent.trim()) {
        await client.chat.update({
          channel: originalChannelId,
          ts: loadingMessage.ts,
          ...createEnhancedMessage({
            text: 'I couldn’t find documentable knowledge in the recent conversation.',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'I couldn’t find documentable knowledge in the recent conversation.\n\nPlease include the specific policy, deadline, file, or process that should change, then try again.',
                },
                block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
              },
            ],
          }),
        });

        await logKnowledgeExtraction(
          userId,
          workspaceId,
          originalChannelId,
          logChannelType,
          !!event.thread_ts,
          Date.now() - startTime,
          false,
          '',
          filteredMessages.length,
          {
            reason: 'No organizational knowledge found',
            messageCount: filteredMessages.length,
          },
          client,
        );
        return;
      }

      // Update loading message with the suggested update content (remove intermediate "Analyzed X messages" step)
      const blocks = [
        {
          type: 'rich_text',
          block_id: createCHOIRBlockId(CHOIRMessageType.DOCUMENT_SUGGESTION),
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                {
                  type: 'text',
                  text: `Sure! I'll suggest the following update to ${managerText}.\n`,
                },
                {
                  type: 'text',
                  text: 'Suggested Update',
                  style: {
                    bold: true,
                  },
                },
              ],
            },
            {
              type: 'rich_text_preformatted',
              elements: [
                {
                  type: 'text',
                  text: extractionResult.cleanContent,
                },
              ],
              border: 0,
            },
          ],
        },
      ];

      // Update the loading message directly with the final content
      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        ...createEnhancedMessage({
          text: `Sure! I'll suggest the following update to ${managerText}.`,
          blocks: blocks,
        }),
      });

      // Send ephemeral message with buttons for the requester only
      await client.chat.postEphemeral({
        channel: originalChannelId,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        user: userId,
        text: 'You can edit the suggested update if needed.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'You can edit the suggested update if needed.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Edit',
                  emoji: true,
                },
                action_id: 'edit_extracted_knowledge',
                value: sessionId,
              },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "When you're ready, click Suggest Update to confirm.",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Suggest Update',
                  emoji: true,
                },
                style: 'primary',
                action_id: isUserManager ? 'apply_extracted_knowledge' : 'send_update_suggestion_to_manager',
                value: sessionId,
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Cancel',
                  emoji: true,
                },
                style: 'danger',
                action_id: 'cancel_knowledge_extraction',
                value: sessionId,
              },
            ],
          },
        ],
      });

      // Store session data
      storeSessionData(
        sessionId,
        {
          originalChannelId,
          originalThreadTs: event.thread_ts,
          userId,
          extractedKnowledge: extractionResult.cleanContent, // Store clean content for editing
          messages: filteredMessages,
          processedMessages: extractionResult.processedMessages, // Store processed messages for View Messages
          publicMessageTs: loadingMessage.ts, // Store public message timestamp for updates
          lastEditedBy: userId, // Track who initially extracted the knowledge
          lastEditedAt: new Date().toISOString(), // Track when it was initially extracted
        },
        SessionType.DOCUMENT_UPDATE,
      );

      // 로그: 성공적인 지식 추출
      const totalProcessingTime = Date.now() - startTime;

      // 지식 추출 로그 (업데이트 요청 처리와 지식 추출을 하나로 통합)
      await logKnowledgeExtraction(
        userId,
        workspaceId,
        originalChannelId,
        logChannelType,
        isThreadMention,
        totalProcessingTime,
        true,
        extractionResult.cleanContent,
        filteredMessages.length,
        {
          sessionId,
          channelName,
          extractorName,
          isUserManager,
          managersCount: managers.length,
          sourceMessageCount: filteredMessages.length,
          hasKnowledgeItem: !!extractionResult.cleanContent,
          sourceMessages: await Promise.all(
            filteredMessages.map(async (msg) => {
              const userId = msg.user || msg.bot_id || 'unknown';
              const username = userId !== 'unknown' ? await getUserName(userId, client) : 'Unknown';
              return {
                userId,
                username,
                text: msg.text || '', // 메시지 내용 전체 저장
                ts: msg.ts || '',
              };
            }),
          ),
        },
        client,
      );

      return true;
    } catch (extractionError) {
      logger.error('Error extracting knowledge:', extractionError);

      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        text: '❌ Failed to extract knowledge from messages.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ Failed to extract knowledge from messages: ${extractionError instanceof Error ? extractionError.message : 'Unknown error'}`,
            },
          },
        ],
      });

      // 로그: 지식 추출 실패
      const workspaceId = await getWorkspaceId(client);
      logUpdateRequestProcessing(
        userId,
        workspaceId,
        originalChannelId,
        event.channel_type || 'public',
        isThreadMention,
        Date.now() - startTime,
        false,
        'Failed to extract knowledge',
        '',
        {
          error: extractionError instanceof Error ? extractionError.message : 'Unknown error',
          errorStack: extractionError instanceof Error ? extractionError.stack : undefined,
        },
      );

      return false;
    }
  } catch (error) {
    logger.error('Error handling update request message:', error);

    // 로그: 전체 처리 실패
    const workspaceId = await getWorkspaceId(client);
    logUpdateRequestProcessing(
      userId,
      workspaceId,
      originalChannelId,
      event.channel_type || 'public',
      isThreadMention,
      Date.now() - startTime,
      false,
      'Error handling update request',
      '',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
      },
    );

    throw error;
  }
}
