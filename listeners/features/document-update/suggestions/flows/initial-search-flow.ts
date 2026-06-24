import type { Document } from '@langchain/core/documents';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { initializeFileSelectionState, storeSearchResults } from 'services/document/document-store';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import type { DocumentMetadata } from 'services/file-registry/types';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { MANAGER_SESSION_EXPIRY } from '../shared';
import { runFileBasedSearch } from './file-based-search-flow';

export interface InitialSearchResult {
  // When true, the caller should stop (a terminal message was already posted).
  shouldReturn: boolean;
  // Dynamic-order suggestions for the recommended file (empty when shouldReturn).
  searchResults: Document<DocumentMetadata>[];
}

export async function runInitialSearch(params: {
  userId: string;
  currentWorkspaceId: string;
  currentDmChannelId: string;
  knowledgeContent: string;
  sessionId: string;
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
  vectorStore: { getAllMarkdownFiles: (workspaceId: string) => any[] };
  client: any;
  logger: any;
}): Promise<InitialSearchResult> {
  const {
    userId,
    currentWorkspaceId,
    currentDmChannelId,
    knowledgeContent,
    sessionId,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    vectorStore,
    client,
    logger,
  } = params;

  logger.info(`[SEARCH DEBUG] Query used for initial search: "${knowledgeContent}"`);
  const workspaceId = await getWorkspaceId(client);

  // The QMD search and the "Create New File" default generation are independent,
  // so run them in parallel to cut the latency before the file picker appears.
  const computeNewFileDefaults = async (): Promise<{ fileName: string; initialContent: string } | undefined> => {
    try {
      const fileList = await new WorkspaceStore().getWritableFilesOrFetch(workspaceId, userId);
      if (fileList.length > 0) {
        const { generateNewFileDefaults } = await import('services/llm/content-generator');
        const defaults = await generateNewFileDefaults(knowledgeContent, fileList, currentWorkspaceId);
        logger.info(`Generated new file defaults: ${defaults.fileName}`);
        return defaults;
      }
    } catch (error) {
      logger.warn('Failed to generate new file defaults:', error);
    }
    return undefined;
  };

  const [searchResults, newFileDefaults] = await Promise.all([
    QmdUpdateAnchorService.getInstance().search({
      workspaceId,
      query: knowledgeContent,
      limit: 5,
    }) as Promise<Document<DocumentMetadata>[]>,
    computeNewFileDefaults(),
  ]);

  storeSearchResults(userId, searchResults, currentWorkspaceId);
  initializeFileSelectionState(userId, false, undefined, searchResults, [], currentWorkspaceId);

  logger.info('=== SIMILARITY SEARCH RESULTS (INITIAL SEARCH) ===');
  logger.info(`Found ${searchResults?.length || 0} documents:`);
  searchResults?.forEach((doc, index) => {
    logger.info(`[${index + 1}] File: ${doc.metadata?.fileName}, NodeId: ${doc.metadata?.nodeId}`);
    logger.info(`    Content: "${doc.pageContent}"`);
  });
  logger.info('=== END SEARCH RESULTS ===');

  // Persist the AI-suggested new-file defaults so the inline "Create New File"
  // button (rendered on each suggestion) can prefill them.
  if (newFileDefaults) {
    const sessionData = (getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any) || {};
    sessionData.newFileDefaults = newFileDefaults;
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);
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
      return { shouldReturn: true, searchResults: [] };
    }

    // Only offer writable files so the recommended target is always selectable.
    const readOnlyFiles = await new WorkspaceStore().getReadOnlyFiles(currentWorkspaceId);
    const availableFiles = allMarkdownFiles
      .filter((file: any) => !readOnlyFiles.includes(file.name))
      .map((file: any) => ({
        fileName: file.name,
        githubUrl: file.githubUrl,
        description: `${file.name} - Documentation file`,
      }));

    try {
      const { createNewSectionFromKnowledge } = await import('services/llm/content-generator');
      const newSectionSuggestion = await createNewSectionFromKnowledge(
        knowledgeContent,
        availableFiles,
        currentWorkspaceId,
      );

      if (newSectionSuggestion?.sectionContent?.trim()) {
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
        return { shouldReturn: true, searchResults: [] };
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
    return { shouldReturn: true, searchResults: [] };
  }

  // Item I: skip the file-selection gate. Open the review directly on the
  // best-matching file (top all-files hit). The caller renders the first
  // suggestion into the existing progress message; the inline file switcher on
  // each suggestion lets the manager retarget to another file.
  const recommendedFile = searchResults[0]?.metadata?.fileName;
  logger.info(`[I] Auto-selecting recommended file for review: ${recommendedFile}`);

  const fileBased = await runFileBasedSearch({
    parsedValue: { selectedFile: recommendedFile, isFileBasedReview: true, isDefaultFile: true },
    userId,
    currentWorkspaceId,
    currentDmChannelId,
    knowledgeContent,
    client,
    logger,
  });

  return { shouldReturn: fileBased.shouldReturn, searchResults: fileBased.searchResults };
}
