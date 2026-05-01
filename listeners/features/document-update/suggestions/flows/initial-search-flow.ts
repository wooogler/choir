import type { Document } from '@langchain/core/documents';
import {
  SessionType,
  deleteProgressMessageTimestamp,
  getProgressMessageTimestamp,
  setLastMessageTimestamp,
  storeSessionData,
} from 'services/common';
import { initializeFileSelectionState, storeSearchResults } from 'services/document/document-store';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import type { DocumentMetadata } from 'services/file-registry/types';
import { GithubService } from 'services/github';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { showFileSelectionDropdown } from '../show-file-selection-dropdown';

export async function runInitialSearch(params: {
  userId: string;
  currentWorkspaceId: string;
  currentDmChannelId: string;
  knowledgeContent: string;
  sessionId: string;
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
  vectorStore: { getAllMarkdownFiles: (workspaceId: string) => any[] };
  progressMessage: any;
  client: any;
  logger: any;
}): Promise<void> {
  const {
    userId,
    currentWorkspaceId,
    currentDmChannelId,
    knowledgeContent,
    sessionId,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    vectorStore,
    progressMessage,
    client,
    logger,
  } = params;

  logger.info(`[SEARCH DEBUG] Query used for initial search: "${knowledgeContent}"`);
  const workspaceId = await getWorkspaceId(client);
  const searchResults: Document<DocumentMetadata>[] = await QmdUpdateAnchorService.getInstance().search({
    workspaceId,
    query: knowledgeContent,
    limit: 5,
  });

  storeSearchResults(userId, searchResults, currentWorkspaceId);
  initializeFileSelectionState(userId, false, undefined, searchResults, [], currentWorkspaceId);

  logger.info('=== SIMILARITY SEARCH RESULTS (INITIAL SEARCH) ===');
  logger.info(`Found ${searchResults?.length || 0} documents:`);
  searchResults?.forEach((doc, index) => {
    logger.info(`[${index + 1}] File: ${doc.metadata?.fileName}, NodeId: ${doc.metadata?.nodeId}`);
    logger.info(`    Content: "${doc.pageContent}"`);
  });
  logger.info('=== END SEARCH RESULTS ===');

  let newFileDefaults: { fileName: string; initialContent: string } | undefined;
  try {
    const workspaceStore = new WorkspaceStore();
    let fileList = await workspaceStore.getWritableFiles(workspaceId);

    if (!fileList || fileList.length === 0) {
      const config = await workspaceStore.getWorkspaceConfig(workspaceId);
      if (config?.githubRepo) {
        const { owner, repo, path } = config.githubRepo;
        const markdownFiles = await GithubService.getInstance().getAllMarkdownFiles({
          owner,
          repo,
          path,
          workspaceId,
          userId,
        });
        await workspaceStore.setMarkdownFilesCache(
          workspaceId,
          markdownFiles.map((file) => ({ name: file.name, path: file.path })),
        );
        fileList = await workspaceStore.getWritableFiles(workspaceId);
      }
    }

    if (fileList && fileList.length > 0) {
      const { generateNewFileDefaults } = await import('services/llm/content-generator');
      newFileDefaults = await generateNewFileDefaults(knowledgeContent, fileList);
      logger.info(`Generated new file defaults: ${newFileDefaults.fileName}`);
    }
  } catch (error) {
    logger.warn('Failed to generate new file defaults:', error);
  }

  if (!searchResults || searchResults.length === 0) {
    const allMarkdownFiles = vectorStore.getAllMarkdownFiles(currentWorkspaceId);
    if (allMarkdownFiles.length === 0) {
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: '📝 No documents found in your repository. Please connect a GitHub repository with markdown files first, or add some markdown files to your repository.',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: {
              type: 'mrkdwn',
              text: '📝 No documents found in your repository. Please connect a GitHub repository with markdown files first, or add some markdown files to your repository.',
            },
          },
        ],
      });
      return;
    }

    const availableFiles = allMarkdownFiles.map((file: any) => ({
      fileName: file.name,
      githubUrl: file.githubUrl,
      description: `${file.name} - Documentation file`,
    }));

    try {
      const { createNewSectionFromKnowledge } = await import('services/llm/content-generator');
      const newSectionSuggestion = await createNewSectionFromKnowledge(knowledgeContent, availableFiles);

      if (newSectionSuggestion) {
        const recommendedFileInfo = availableFiles.find(
          (file: any) => file.fileName === newSectionSuggestion.recommendedFile,
        );
        const githubUrl = recommendedFileInfo?.githubUrl || availableFiles[0]?.githubUrl || '';
        const newSectionSessionId = `new_section_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        storeSessionData(
          newSectionSessionId,
          {
            sectionTitle: newSectionSuggestion.sectionTitle,
            sectionContent: newSectionSuggestion.sectionContent,
            recommendedFile: newSectionSuggestion.recommendedFile,
            reasoning: newSectionSuggestion.reasoning,
            githubUrl,
            originalChannelId: knowledgeSourceChannelId,
            originalThreadTs: knowledgeSourceThreadTs,
            sessionId,
          },
          SessionType.NEW_SECTION,
        );

        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: `💡 Since you don't have any existing content in your vector store, I'll help you create a new section for this knowledge!`,
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.DOCUMENT_SUGGESTION),
              text: {
                type: 'mrkdwn',
                text: `💡 *No existing content found - Let's create something new!*\n\nI've prepared a new section for your knowledge. Click below to review and add it to your documentation.`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '📝 Create New Section', emoji: true },
                  action_id: 'create_new_section',
                  value: JSON.stringify({ newSectionSessionId, userId }),
                },
              ],
            },
          ],
        });
        return;
      }
    } catch (error) {
      console.error('Error creating new section when no search results found:', error);
    }

    await client.chat.postMessage({
      channel: currentDmChannelId,
      text: 'No relevant documents found for the extracted knowledge. Please try with different knowledge or contact an administrator.',
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          text: {
            type: 'mrkdwn',
            text: 'No relevant documents found for the extracted knowledge. Please try with different knowledge or contact an administrator.',
          },
        },
      ],
    });
    return;
  }

  const progressTimestamp = getProgressMessageTimestamp(userId);
  const progressChannel = progressMessage?.channel || currentDmChannelId;
  console.log(
    `[DEBUG] About to show file selection. progressTimestamp: ${progressTimestamp}, progressChannel: ${progressChannel}, currentDmChannelId: ${currentDmChannelId}`,
  );

  const fileSelectionMessageTs = await showFileSelectionDropdown(
    client,
    userId,
    progressChannel,
    searchResults,
    knowledgeContent,
    sessionId,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    progressTimestamp,
    newFileDefaults,
  );

  console.log(
    `[DEBUG] File selection result. fileSelectionMessageTs: ${fileSelectionMessageTs}, was progressTimestamp used: ${!!progressTimestamp}`,
  );

  if (fileSelectionMessageTs) {
    setLastMessageTimestamp(userId, fileSelectionMessageTs);
  }

  if (progressTimestamp) {
    deleteProgressMessageTimestamp(userId);
    console.log(`[DEBUG] Cleared progress message timestamp: ${progressTimestamp}`);
  }
}
