import type { Document } from '@langchain/core/documents';
import {
  calculateDynamicOrder,
  getSearchResults,
  initializeFileSelectionState,
} from 'services/document/document-store';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import type { DocumentMetadata } from 'services/file-registry/types';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

export interface FileBasedSearchResult {
  shouldReturn: boolean;
  searchResults: Document<DocumentMetadata>[];
  isFirstSuggestion: boolean;
}

export async function runFileBasedSearch(params: {
  parsedValue: any;
  userId: string;
  currentWorkspaceId: string;
  currentDmChannelId: string;
  knowledgeContent: string;
  client: any;
  logger: any;
}): Promise<FileBasedSearchResult> {
  const { parsedValue, userId, currentWorkspaceId, currentDmChannelId, knowledgeContent, client, logger } = params;

  logger.info(
    `Performing file-based search for file: ${parsedValue.selectedFile}, isFileBasedReview: ${parsedValue.isFileBasedReview}, isDefaultFile: ${parsedValue.isDefaultFile}`,
  );

  const initialSearchResults = getSearchResults(userId, currentWorkspaceId) || [];
  const workspaceId = await getWorkspaceId(client);

  logger.info(
    parsedValue.isDefaultFile
      ? 'Default/recommended file selected - performing file-specific search'
      : `Searching in specific file: ${parsedValue.selectedFile}`,
  );
  logger.info(`[SEARCH DEBUG] Query used for file search: "${knowledgeContent}"`);

  const fileSpecificResults = await QmdUpdateAnchorService.getInstance().search({
    workspaceId,
    query: knowledgeContent,
    selectedFile: parsedValue.selectedFile,
    limit: 5,
  });

  logger.info(`=== FILE-SPECIFIC SEARCH RESULTS (${parsedValue.selectedFile}) ===`);
  logger.info(`Found ${fileSpecificResults.length} documents:`);
  fileSpecificResults.forEach((doc, index) => {
    logger.info(`[${index + 1}] File: ${doc.metadata?.fileName}, NodeId: ${doc.metadata?.nodeId}`);
    logger.info(`    Content: "${doc.pageContent}"`);
  });
  logger.info('=== END FILE-SPECIFIC RESULTS ===');

  initializeFileSelectionState(
    userId,
    true,
    parsedValue.selectedFile,
    initialSearchResults,
    fileSpecificResults,
    currentWorkspaceId,
  );

  const searchResults = calculateDynamicOrder(userId, currentWorkspaceId);
  logger.info(`Dynamic order calculated: ${searchResults.length} total documents available`);

  if (searchResults.length === 0) {
    await client.chat.postMessage({
      channel: currentDmChannelId,
      text: `No relevant content found in the selected file: ${parsedValue.selectedFile}. Please try selecting a different file or choose "All Files" option.`,
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          text: {
            type: 'mrkdwn',
            text: `No relevant content found in the selected file: ${parsedValue.selectedFile}. Please try selecting a different file or choose "All Files" option.`,
          },
        },
      ],
    });
    return { shouldReturn: true, searchResults: [], isFirstSuggestion: true };
  }

  return { shouldReturn: false, searchResults, isFirstSuggestion: true };
}
