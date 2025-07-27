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
    const selectedFile = fileSelections.get(selectionKey) || parsedValue.selectedFile;

    // Clean up the selection from memory after use
    if (messageTs) {
      fileSelections.delete(selectionKey);
    }

    logger.info(`Starting file-based review with selectedFile: ${selectedFile}, sessionId: ${sessionId}`);

    // Show user's selection using response_url instead of deleting message
    if (responseUrl) {
      try {
        const selectedFileName = selectedFile.split('/').pop() || selectedFile;
        const response = await fetch(responseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            replace_original: true,
            text: `📁 Selected file: ${selectedFileName}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `📁 *Selected file:* ${selectedFileName}`,
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
            selectedFile, // Pass the selected file
            defaultFilePath, // Pass default file path
            isFileBasedReview: true, // Flag to indicate this is file-based review
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
