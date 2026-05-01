import type { Document } from '@langchain/core/documents';
import { getFileSelectionState } from 'services/document/document-store';
import type { DocumentMetadata } from 'services/file-registry/types';
import { getWorkspaceId } from 'services/slack';

export async function handleSkip(params: {
  parsedValue: any;
  userId: string;
  currentWorkspaceId: string;
  currentDmChannelId: string | undefined;
  startTime: number;
  sessionId: string;
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
  searchResults: Document<DocumentMetadata>[];
  currentIndex: number;
  body: any;
  client: any;
  logger: any;
  onNextSuggestion: (args: any) => Promise<void>;
}): Promise<void> {
  const {
    parsedValue,
    userId,
    currentWorkspaceId,
    currentDmChannelId,
    startTime,
    sessionId,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    searchResults,
    currentIndex,
    body,
    client,
    logger,
    onNextSuggestion,
  } = params;

  logger.info(`User skipped suggestion ${currentIndex} for nodeId: ${parsedValue.currentNodeId}`);

  const currentFileState = getFileSelectionState(userId, currentWorkspaceId);
  const suggestionNumber = currentFileState?.currentSuggestionCount || 1;
  const fileName = parsedValue.currentNodeId
    ? searchResults.find((doc) => doc.metadata?.nodeId === parsedValue.currentNodeId)?.metadata?.fileName ||
      'Unknown file'
    : 'Unknown file';

  try {
    const workspaceId = await getWorkspaceId(client);
    const { logButtonClick } = await import('services/common/interaction-tracker');
    await logButtonClick(
      userId,
      workspaceId,
      currentDmChannelId || 'dm',
      'dm',
      'skip_suggestion',
      Date.now() - startTime,
      true,
      {
        sessionId,
        currentIndex,
        suggestionNumber,
        nodeId: parsedValue.currentNodeId,
        fileName,
        originalChannelId: knowledgeSourceChannelId,
        originalThreadTs: knowledgeSourceThreadTs,
      },
      client,
    );
  } catch (logError) {
    logger.error('Failed to log skip suggestion:', logError);
  }

  const responseUrl = body.response_url;
  if (responseUrl) {
    try {
      logger.info(
        `Skip message: suggestionNumber=${suggestionNumber}, fileName=${fileName}, nodeId=${parsedValue.currentNodeId}`,
      );
      const response = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          text: `⏭️ Skipped suggestion ${suggestionNumber} for ${fileName}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `⏭️ *Skipped* suggestion ${suggestionNumber} for ${fileName}` },
            },
          ],
        }),
      });
      if (response.ok) {
        logger.info(`Successfully used response_url to show skip confirmation for suggestion ${suggestionNumber}`);
      } else {
        logger.warn(`Failed to use response_url for skip confirmation: ${response.status} ${response.statusText}`);
      }
    } catch (responseUrlError) {
      logger.error('Error using response_url for skip confirmation:', responseUrlError);
    }
  } else {
    logger.warn('No response_url available for skip confirmation');
  }

  const nextButtonValue = {
    index: currentIndex + 1,
    sessionId,
    isFileBasedReview: parsedValue.isFileBasedReview,
    selectedFile: parsedValue.selectedFile,
    isDefaultFile: parsedValue.isDefaultFile,
  };

  setTimeout(async () => {
    try {
      await onNextSuggestion({
        ack: async () => {},
        body: {
          ...body,
          actions: [{ value: JSON.stringify(nextButtonValue) }],
        },
        client,
        logger,
      });
    } catch (nextError) {
      logger.error('Error processing next suggestion after skip:', nextError);
    }
  }, 500);
}
