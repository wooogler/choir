import type { Document } from '@langchain/core/documents';
import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import {
  deleteProgressMessageTimestamp,
  getProgressMessageTimestamp,
  setLastMessageTimestamp,
  setProgressMessageTimestamp,
} from 'services/common';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import {
  type DocumentUpdate,
  calculateDynamicOrder,
  clearFileSelectionState,
  getFileSelectionState,
  getNextSuggestion,
  getSearchResults,
  getStoredDocumentUpdates,
  incrementSuggestionCount,
  isMaxSuggestionsReached,
  storeDocumentUpdates,
} from 'services/document/document-store';
import { type ProcessedDocument, processDocument } from 'services/document/update-processor';
import { VectorStoreService } from 'services/file-registry/main-service';
import type { DocumentMetadata } from 'services/file-registry/types';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { buildSuggestionBlocks } from './blocks/suggestion-blocks';
import { handleCompletion } from './flows/completion-flow';
import { runConcurrencyControl } from './flows/concurrency-control';
import { runFileBasedSearch } from './flows/file-based-search-flow';
import { runInitialSearch } from './flows/initial-search-flow';
import { handleKeep } from './flows/keep-flow';
import { showReviewScreen } from './flows/review-screen-flow';
import { handleSkip } from './flows/skip-flow';
import { stripStaleButtons } from './message-cleanup';
import { MANAGER_SESSION_EXPIRY } from './shared';
import { loadSourceContext } from './source-message-loader';

export { createMessageLink } from './shared';

export const suggestUpdatesCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  const userId = body.user.id;
  const currentDmChannelId = body.channel?.id;
  const messageTsOfButtonClicked = body.container?.message_ts;
  const vectorStore = VectorStoreService.getInstance();
  const currentWorkspaceId = await getWorkspaceId(client);

  const isConflict = await runConcurrencyControl({ userId, currentDmChannelId, body, client, logger });
  if (isConflict) return;

  try {
    await stripStaleButtons(client, userId, currentDmChannelId, messageTsOfButtonClicked, logger);

    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }
    const parsedValue = JSON.parse(value);
    console.log('[DEBUG] Raw button value:', value);
    console.log('[DEBUG] Parsed button value:', parsedValue);

    // 로깅 체크를 여기로 이동
    const workspaceId = await getWorkspaceId(client);

    // 매니저가 처음 문서 업데이트 프로세스를 시작하는 경우와 실제 제안을 표시하는 경우 구분
    // 조건: index가 없고, action이 없고, sessionId만 있는 경우는 initial start
    const isInitialProcessStart =
      typeof parsedValue?.index === 'undefined' && !parsedValue?.action && !!parsedValue?.sessionId;

    console.log('[DEBUG] Logging condition check:', {
      parsedValueIndex: parsedValue?.index,
      indexType: typeof parsedValue?.index,
      parsedValueAction: parsedValue?.action,
      continueToFileSelection: parsedValue?.continueToFileSelection,
      isFileBasedReview: parsedValue?.isFileBasedReview,
      sessionId: parsedValue?.sessionId,
      isInitialProcessStart,
    });

    if (isInitialProcessStart) {
      // 매니저가 처음 "🚀 Start Update Process" 버튼을 클릭한 경우
      // Get actual knowledge content from session data
      let actualKnowledgeContent = parsedValue?.knowledgeContent || '';
      if (!actualKnowledgeContent && parsedValue?.sessionId) {
        const sessionData = getSessionData(parsedValue.sessionId, SessionType.DOCUMENT_UPDATE) as any;
        if (sessionData?.extractedKnowledge) {
          actualKnowledgeContent = sessionData.extractedKnowledge;
        }
      }

      await logButtonClick(
        userId,
        workspaceId,
        currentDmChannelId || 'dm',
        'dm',
        'start_document_update_process',
        Date.now() - startTime,
        true,
        {
          sessionId: parsedValue?.sessionId,
          knowledgeContent: actualKnowledgeContent,
          knowledgeContentLength: actualKnowledgeContent.length,
          originalChannelId: parsedValue?.originalChannelId,
          originalThreadTs: parsedValue?.originalThreadTs,
        },
        client,
      );
    }

    let currentIndex = 0;
    let searchResults: Document<DocumentMetadata>[] = [];
    let isFirstSuggestion = true;
    const sessionId = parsedValue.sessionId;
    let isFileBasedReview = false;

    if (!currentDmChannelId) {
      throw new Error('DM Channel ID not found in current context');
    }
    const dmChannelId = currentDmChannelId;

    const { knowledgeContent, validMessages, knowledgeSourceChannelId, knowledgeSourceThreadTs } =
      await loadSourceContext(parsedValue, userId, client, logger);

    if (typeof parsedValue.index === 'number') {
      currentIndex = parsedValue.index;

      // Check if this is a file-based review - set this early to avoid duplicate searches
      isFileBasedReview = parsedValue.isFileBasedReview || false;

      if (parsedValue.isFileBasedReview && parsedValue.selectedFile) {
        const result = await runFileBasedSearch({
          parsedValue,
          userId,
          currentWorkspaceId,
          currentDmChannelId: dmChannelId,
          knowledgeContent,
          client,
          logger,
        });
        if (result.shouldReturn) return;
        searchResults = result.searchResults;
        isFirstSuggestion = result.isFirstSuggestion;
      } else {
        logger.info(
          `Using cached search results, isFileBasedReview: ${parsedValue.isFileBasedReview}, selectedFile: ${parsedValue.selectedFile}`,
        );
        if (!parsedValue.isFileBasedReview) {
          searchResults = getSearchResults(userId, currentWorkspaceId) || [];
          logger.info(`Using initial search results only (no file selected): ${searchResults.length} documents`);
        } else {
          searchResults = calculateDynamicOrder(userId, currentWorkspaceId);
          logger.info(`Using dynamic order (file selected): ${searchResults.length} documents`);
        }
        isFirstSuggestion = false;
      }

      if (parsedValue.action === 'skip') {
        await handleSkip({
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
          onNextSuggestion: suggestUpdatesCallback,
        });
        return;
      }

      if (parsedValue.action === 'keep' && parsedValue.currentNodeId) {
        await handleKeep({
          parsedValue,
          userId,
          currentWorkspaceId,
          currentDmChannelId: dmChannelId,
          sessionId,
          body,
          client,
          logger,
        });
      }
    } else {
      // Manager starting the update process for the first time
      isFirstSuggestion = true;
      currentIndex = 0;
      storeDocumentUpdates(userId, [], undefined, undefined, currentWorkspaceId);

      const reviewShown = await showReviewScreen({
        sessionId,
        userId,
        currentDmChannelId: dmChannelId,
        knowledgeContent,
        parsedValue,
        client,
        logger,
      });
      if (reviewShown) return;
    }

    if (!knowledgeContent) {
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: 'No knowledge content found. Please try again.',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: 'No knowledge content found. Please try again.' },
          },
        ],
      });
      return;
    }

    // Show appropriate loading message based on the stage
    const loadingFileState = getFileSelectionState(userId, currentWorkspaceId);
    const loadingText =
      currentIndex === 0 && !isFileBasedReview
        ? '🔍 Finding relevant documents across all files...'
        : loadingFileState?.isFileSelected
          ? `📝 Generating suggestions for ${loadingFileState.selectedFile}...`
          : '📝 Generating update suggestions...';

    const progressMessage = await client.chat.postMessage({
      channel: currentDmChannelId,
      text: loadingText,
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
          text: { type: 'mrkdwn', text: loadingText },
        },
      ],
    });
    if (progressMessage.ts) {
      setProgressMessageTimestamp(userId, progressMessage.ts);
      const actualChannel = progressMessage.channel || currentDmChannelId;
      console.log(
        `[DEBUG] Progress message created. ts: ${progressMessage.ts}, channel: ${actualChannel}, originalDmChannelId: ${currentDmChannelId}`,
      );
    }

    if (currentIndex === 0 && !isFileBasedReview && (!searchResults || searchResults.length === 0)) {
      // Item I: instead of showing a file-selection gate, runInitialSearch opens
      // the review directly on the best-matching file and returns its suggestions.
      // We fall through to render the first one into this same progress message.
      const init = await runInitialSearch({
        userId,
        currentWorkspaceId,
        currentDmChannelId: dmChannelId,
        knowledgeContent,
        sessionId,
        knowledgeSourceChannelId,
        knowledgeSourceThreadTs,
        vectorStore,
        client,
        logger,
      });
      if (init.shouldReturn) return;
      searchResults = init.searchResults;
      isFileBasedReview = true;
    }

    logger.info(`Debug: currentIndex=${currentIndex}, searchResults.length=${searchResults.length}`);

    // 새로운 로직: completion 체크
    const fileSelectionState = getFileSelectionState(userId, currentWorkspaceId);
    const shouldComplete = fileSelectionState?.isFileSelected
      ? isMaxSuggestionsReached(userId, currentWorkspaceId)
      : currentIndex >= searchResults.length;

    logger.info(
      `Completion check: fileSelected=${fileSelectionState?.isFileSelected}, maxReached=${fileSelectionState?.isFileSelected ? isMaxSuggestionsReached(userId, currentWorkspaceId) : 'N/A'}, shouldComplete=${shouldComplete}`,
    );

    if (shouldComplete) {
      await handleCompletion({
        userId,
        currentWorkspaceId,
        currentDmChannelId: dmChannelId,
        client,
        logger,
        knowledgeContent,
        knowledgeSourceChannelId,
        knowledgeSourceThreadTs,
        sessionId,
      });
      return;
    }

    // 새로운 로직: 다음 suggestion 가져오기 및 카운트 증가
    const nextSuggestion = getNextSuggestion(userId, currentWorkspaceId);
    if (!nextSuggestion) {
      logger.warn(`No next suggestion available for user ${userId}`);
      // 다시 completion 체크 후 completion 처리
      return;
    }

    const currentDoc = nextSuggestion;

    // suggestion 번호 계산 (카운트 증가 전에)
    const currentFileState = getFileSelectionState(userId, currentWorkspaceId);
    const suggestionDisplayNumber = (currentFileState?.currentSuggestionCount || 0) + 1;

    // suggestion 카운트 증가 (표시 후)
    incrementSuggestionCount(userId, currentWorkspaceId);
    const processedDoc: ProcessedDocument | null = await processDocument(
      currentDoc,
      knowledgeContent,
      validMessages,
      client,
      vectorStore,
      currentWorkspaceId,
      userId,
    );

    // processedDoc이 null이거나 변경사항이 없어도 사용자에게 표시 (자동 스킵 방지)
    if (!processedDoc) {
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: '❌ Error processing document. Skipping to next.',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: '❌ Error processing document. Skipping to next.' },
          },
        ],
      });
      return;
    }

    const documentUpdateEntry: DocumentUpdate = {
      index: currentIndex,
      fileName: processedDoc.fileName,
      githubUrl: processedDoc.githubUrl,
      markdownSection: processedDoc.sectionName || 'Main Content',
      headingPath: processedDoc.headingPath,
      hasChanges: processedDoc.hasChanges,
      nodeContent: processedDoc.nodeContent,
      updatedNodeContent: processedDoc.updatedNodeContent,
      diffBlock: processedDoc.diffBlock,
      nodeId: processedDoc.nodeId,
      oldContent: processedDoc.oldContent,
      newContent: processedDoc.newContent,
      messages: validMessages,
      timestamp: new Date().toISOString(),
      knowledgeContent: knowledgeContent,
      originalChannelId: knowledgeSourceChannelId,
      originalThreadTs: knowledgeSourceThreadTs,
      suggestionType: processedDoc.suggestionType,
      updateAnchor: processedDoc.updateAnchor,
    };

    const currentUpdates = getStoredDocumentUpdates(userId, currentWorkspaceId);
    const existingUpdateIndex = currentUpdates.findIndex(
      (update) => update.nodeId === documentUpdateEntry.nodeId && update.index === currentIndex,
    );
    if (existingUpdateIndex >= 0) {
      currentUpdates[existingUpdateIndex] = documentUpdateEntry;
    } else {
      currentUpdates.push(documentUpdateEntry);
    }
    storeDocumentUpdates(userId, currentUpdates, undefined, undefined, currentWorkspaceId);

    const blocks = await buildSuggestionBlocks({
      processedDoc,
      currentIndex,
      sessionId,
      knowledgeContent,
      knowledgeSourceChannelId,
      knowledgeSourceThreadTs,
      userId,
      isFirstSuggestion,
      suggestionNumber: suggestionDisplayNumber,
      client,
    });

    // Try to update the existing progress message with the suggestion
    const progressTimestamp = getProgressMessageTimestamp(userId);
    const progressChannel = progressMessage?.channel || currentDmChannelId;

    let suggestionMessageTs: string | undefined;

    if (progressTimestamp && progressChannel) {
      try {
        await client.chat.update({
          channel: progressChannel,
          ts: progressTimestamp,
          blocks: blocks,
          text: 'Document Update Suggestions',
        });
        console.log(`Successfully updated progress message ${progressTimestamp} to suggestion`);
        suggestionMessageTs = progressTimestamp;

        // Clear progress timestamp since it's now the suggestion message
        deleteProgressMessageTimestamp(userId);
      } catch (updateError: any) {
        console.warn(`Failed to update progress message ${progressTimestamp}:`, updateError?.message || updateError);
        console.log('Falling back to creating new suggestion message');

        // Fallback to new message if update fails
        const result = await client.chat.postMessage({
          channel: dmChannelId,
          blocks: blocks,
          unfurl_links: false,
          unfurl_media: false,
          text: 'Document Update Suggestions',
        });
        suggestionMessageTs = result.ts;
      }
    } else {
      // Create new message if no progress message timestamp
      console.log('No progress message timestamp available, creating new suggestion message');
      const result = await client.chat.postMessage({
        channel: dmChannelId,
        blocks: blocks,
        unfurl_links: false,
        unfurl_media: false,
        text: 'Document Update Suggestions',
      });
      suggestionMessageTs = result.ts;
    }

    if (suggestionMessageTs) {
      setLastMessageTimestamp(userId, suggestionMessageTs);
    }

    // Store main message timestamp for Create New Section updates
    if (suggestionMessageTs && sessionId && processedDoc.newSectionSuggestion) {
      const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
      if (sessionData) {
        sessionData.mainMessageTs = suggestionMessageTs;
        sessionData.mainChannelId = currentDmChannelId;
        // 매니저 제안 세션은 14일 동안 유효하도록 설정
        storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);
      }
    }

    // Log suggestion display
    try {
      const workspaceId = await getWorkspaceId(client);
      const { logMessageProcessing } = await import('services/common/interaction-tracker');
      await logMessageProcessing(
        userId,
        workspaceId,
        currentDmChannelId || 'dm',
        'dm',
        false, // isThread
        Date.now() - startTime,
        true,
        '', // messageContent - empty since this is a system-generated suggestion
        'display_update_suggestion',
        {
          sessionId,
          suggestionNumber: suggestionDisplayNumber,
          currentIndex,
          fileName: processedDoc.fileName,
          nodeId: processedDoc.nodeId,
          sectionName: processedDoc.sectionName,
          suggestionType: processedDoc.suggestionType,
          hasChanges: processedDoc.hasChanges,
          originalNodeContent: processedDoc.nodeContent,
          updatedNodeContent: processedDoc.updatedNodeContent,
          originalContentLength: processedDoc.nodeContent?.length || 0,
          updatedContentLength: processedDoc.updatedNodeContent?.length || 0,
          originalChannelId: knowledgeSourceChannelId,
          originalThreadTs: knowledgeSourceThreadTs,
          isFirstSuggestion,
          wasProgressMessageUpdated: !!progressTimestamp,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log suggestion display:', logError);
    }

    logger.info(`Document update suggestion ${currentIndex + 1} sent to user ${userId} for session ${sessionId}`);
  } catch (error) {
    console.error('suggestUpdatesCallback에서 오류:', error);

    if (currentDmChannelId) {
      try {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: `An error occurred while suggesting document updates: ${error instanceof Error ? error.message : 'Unknown error'}`,
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
              text: {
                type: 'mrkdwn',
                text: `An error occurred while suggesting document updates: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            },
          ],
        });
      } catch (dmError) {
        console.error('DM 전송 오류:', dmError);
      }
    }

    // 새로운 로직: 에러 발생 시에도 상태 정리
    clearFileSelectionState(userId, currentWorkspaceId);
    logger.info(`Cleared file selection state for user ${userId} after error`);
  }
};

export default suggestUpdatesCallback;
