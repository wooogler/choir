import type { WebClient } from '@slack/web-api';
import { SessionType, generateSessionId, storeSessionData } from 'services/common';
import { logKnowledgeExtraction, logUpdateRequestProcessing } from 'services/common/user-interaction-logger';
import { extractKnowledgeFromMessages } from 'services/llm/knowledge-extractor';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import {
  type SlackMessage,
  getCHOIRUsers,
  getChannelName,
  getFilteredConversationHistory,
  getManagers,
  getQAChannel,
  getUserName,
  getWorkspaceId,
  classifyChannel,
  isManager,
} from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { createEnhancedMessage } from 'services/slack/message-text-utils';


/**
 * Handle update request message with automatic knowledge extraction
 */
export async function handleUpdateRequestMessage(client: WebClient, event: any, logger: any) {
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
      choirUsersCount: choirUsers.length
    });

    // Use timeLimit from channel classification, with thread override
    const timeLimit = event.thread_ts ? 1440 : channelClassification.timeLimit; // 24 hours for threads, otherwise use classification
    
    const filteredMessages = await getFilteredConversationHistory(client, event, choirUsers, {
      timeLimit, // Use classified timeLimit
      messageLimit: 15, // fetch up to 15 messages
      maxResults: 15, // return up to 15 messages including bot responses
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
    // Sort messages by timestamp (oldest first) - they should already be sorted but ensure consistency
    const sortedMessages = [...filteredMessages].sort((a, b) => {
      const tsA = Number.parseFloat(a.ts || '0');
      const tsB = Number.parseFloat(b.ts || '0');
      return tsA - tsB;
    });

    // Take the last 10 messages for knowledge extraction
    const last10Messages = sortedMessages.slice(-10);

    if (last10Messages.length === 0) {
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
      let managerText = 'managers';
      if (managers.length > 0) {
        // Get first manager's name as example
        const firstManagerName = await getUserName(managers[0], client);
        managerText = managers.length === 1 ? firstManagerName : `${firstManagerName} and other managers`;
      }

      // Get workspace configuration for organizational context
      const workspaceStore = new WorkspaceStore();
      const workspaceConfig = await workspaceStore.getWorkspaceConfig(workspaceId);

      // Use channel classification for context
      let channelType = channelClassification.displayName;
      if (event.thread_ts) {
        channelType = 'Thread Discussion';
      }

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
      const extractionResult = await extractKnowledgeFromMessages(last10Messages, organizationalContext, client);

      // Update loading message with compact analysis summary
      const statusUpdateData = createEnhancedMessage({
        text: `✅ Analyzed ${last10Messages.length} message${last10Messages.length > 1 ? 's' : ''} to extract knowledge`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *Analysis Complete* • 📊 ${last10Messages.length} message${last10Messages.length > 1 ? 's' : ''} analyzed`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.STATUS_UPDATE),
            accessory: {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'View Messages',
                emoji: true,
              },
              action_id: 'view_analyzed_messages',
              value: JSON.stringify({
                sessionId,
                messageCount: extractionResult.processedMessages.length,
                messages: extractionResult.processedMessages.map((msg, index) => ({
                  username: msg.role === 'CHOIR' ? 'CHOIR' : msg.content.split(':')[0], // Extract username from "Username: message" format
                  text: msg.content.includes(':') ? msg.content.split(':').slice(1).join(':').trim() : msg.content,
                  ts: `${Date.now()}_${index}`, // Generate unique timestamp for ordering
                })),
              }),
            },
          },
        ],
      }, {
        buttons: [{ text: 'View Messages', style: 'primary' }]
      });

      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        ...statusUpdateData,
      });

      // First: Send public message with the suggested update content
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Sure! I'll suggest the following update to ${managerText}.\n*Suggested Update*\n\`\`\`${extractionResult.cleanContent}\`\`\``,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.DOCUMENT_SUGGESTION),
        },
      ];

      const publicMessage = await client.chat.postMessage({
        channel: originalChannelId,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        ...createEnhancedMessage(
          {
            text: `Sure! I'll suggest the following update to ${managerText}.`,
            blocks: blocks
          }
        ),
      });

      // Wait 1 second to ensure the public message appears first
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Second: Send ephemeral message with buttons for the requester only
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
          detailedKnowledge: extractionResult.detailedContent, // Store detailed content for source viewing
          knowledgeItem: extractionResult.knowledgeItem, // Store structured data
          messages: last10Messages,
          publicMessageTs: publicMessage.ts, // Store public message timestamp for updates
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
        event.channel_type || 'public',
        isThreadMention,
        totalProcessingTime,
        true,
        extractionResult.cleanContent,
        last10Messages.length,
        {
          sessionId,
          channelName,
          extractorName,
          isUserManager,
          managersCount: managers.length,
          sourceMessageCount: last10Messages.length,
          hasKnowledgeItem: !!extractionResult.knowledgeItem,
          sourceMessages: last10Messages.map((msg) => ({
            userId: msg.user || msg.bot_id || 'unknown',
            username: msg.username || 'Unknown',
            text: msg.text?.substring(0, 200) || '', // 메시지 내용 일부만 저장
            ts: msg.ts || '',
          })),
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
