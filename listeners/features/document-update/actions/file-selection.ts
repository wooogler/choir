import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

// Simple in-memory storage for file selections to avoid rate limits
const fileSelections = new Map<string, string>();

/**
 * Handle file selection dropdown change - simplified without chat.update to avoid rate limits
 */
export const fileSelectionForUpdateAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs) => {
  await ack();

  try {
    const selectedFile = (body as any).actions[0].selected_option?.value;
    const userId = (body as any).user.id;
    const messageTs = (body as any).container?.message_ts;

    if (!selectedFile || !userId || !messageTs) {
      return;
    }

    // Store the selected file in memory for later retrieval
    const selectionKey = `${userId}_${messageTs}`;
    fileSelections.set(selectionKey, selectedFile);

    logger.info(`User ${userId} selected file: ${selectedFile}`);
  } catch (error) {
    logger.error('Error handling file selection:', error);
  }
};

/**
 * Handle "Start Review" button click
 */
export const startFileBasedReviewAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  const userId = body.user.id;
  const channelId = body.channel?.id;
  const responseUrl = body.response_url;

  try {
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const {
      sessionId,
      knowledgeContent,
      knowledgeSourceChannelId,
      knowledgeSourceThreadTs,
      defaultFilePath, // 기본 파일 정보
    } = parsedValue;

    // Get the currently selected file from the dropdown or use default
    const messageTs = body.container?.message_ts;
    const selectionKey = `${userId}_${messageTs}`;
    let selectedFile = fileSelections.get(selectionKey) || parsedValue.selectedFile;
    let isUsingDefaultFile = false;
    
    // If no explicit selection was made, but we have a defaultFilePath, use it
    if (!selectedFile && defaultFilePath) {
      selectedFile = defaultFilePath;
      isUsingDefaultFile = true;
      logger.info(`No explicit file selection, using default file: ${defaultFilePath}`);
    }
    
    // Check if a file was actually selected
    let shouldUseFileBasedReview = true;
    if (!selectedFile) {
      // No file selected and no default - use initial search only
      shouldUseFileBasedReview = false;
      logger.info(`No file selected, using initial search results only`);
    } else if (selectedFile === defaultFilePath) {
      // Default/recommended file explicitly selected
      isUsingDefaultFile = true;
    }

    // Clean up the selection from memory after use
    if (messageTs) {
      fileSelections.delete(selectionKey);
    }

    logger.info(`Starting review with selectedFile: ${selectedFile}, shouldUseFileBasedReview: ${shouldUseFileBasedReview}, sessionId: ${sessionId}`);

    // Show user's selection using response_url instead of deleting message
    if (responseUrl) {
      try {
        let messageText, blockText;
        
        if (!shouldUseFileBasedReview) {
          messageText = `📚 Reviewing all relevant files`;
          blockText = `📚 *Reviewing all relevant files*\n\n_I'll search across all your documentation to find the most relevant content for your knowledge._`;
        } else {
          const selectedFileName = selectedFile.split('/').pop() || selectedFile;
          if (isUsingDefaultFile) {
            messageText = `📁 Using recommended file: ${selectedFileName}`;
            blockText = `📁 *Using recommended file:* ${selectedFileName}\n\n_This file was recommended as the most relevant for your content._`;
          } else {
            messageText = `📁 Selected file: ${selectedFileName}`;
            blockText = `📁 *Selected file:* ${selectedFileName}`;
          }
        }
        
        const response = await fetch(responseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            replace_original: true,
            text: messageText,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: blockText,
                },
              },
            ],
            unfurl_links: false,
            unfurl_media: false,
          }),
        });

        if (!response.ok) {
          console.error('Failed to send selection response:', await response.text());
        }
      } catch (error) {
        logger.error('Failed to send selection via response_url:', error);
      }
    }

    // Now trigger the actual suggestion flow with the selected file
    const { suggestUpdatesCallback } = await import('../suggestions/suggest-updates');

    // Create a modified body for the suggest updates callback
    const isDefaultFile = selectedFile === defaultFilePath;
    const modifiedBody = {
      ...body,
      actions: [
        {
          value: JSON.stringify({
            index: 0,
            sessionId,
            knowledgeContent,
            originalChannelId: knowledgeSourceChannelId,
            originalThreadTs: knowledgeSourceThreadTs,
            selectedFile: shouldUseFileBasedReview ? selectedFile : undefined, // Pass selected file only if file-based review
            defaultFilePath, // Pass default file path
            isFileBasedReview: shouldUseFileBasedReview, // Flag based on whether file was selected
            isDefaultFile, // Flag to indicate if selected file is the default file
          }),
        },
      ],
    };

    await suggestUpdatesCallback({
      ack: async () => {}, // Already acked
      body: modifiedBody,
      client,
      logger,
    } as any);

    // Log the action
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      userId,
      workspaceId,
      channelId || 'dm',
      'dm',
      'start_file_based_review',
      Date.now() - startTime,
      true,
      {
        sessionId,
        selectedFile,
        defaultFilePath,
        isUsingDefaultFile,
        fileSelectionMethod: isUsingDefaultFile ? 'automatic' : 'manual',
        knowledgeContentLength: knowledgeContent?.length || 0,
        originalChannelId: knowledgeSourceChannelId,
        originalThreadTs: knowledgeSourceThreadTs,
      },
      client,
    );
  } catch (error) {
    logger.error('Error starting file-based review:', error);

    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Error starting review: ${error instanceof Error ? error.message : 'Unknown error'}`,
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: {
              type: 'mrkdwn',
              text: `❌ Error starting review: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          },
        ],
      });
    }

    // Log the error
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        userId,
        workspaceId,
        channelId || 'dm',
        'dm',
        'start_file_based_review',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log error:', logError);
    }
  }
};
