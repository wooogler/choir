import type { Document } from '@langchain/core/documents';
import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/web-api';
import {
  deleteProgressMessageTimestamp,
  getLastMessageTimestamp,
  getProgressMessageTimestamp,
  setLastMessageTimestamp,
  setProgressMessageTimestamp,
} from 'services/common';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import {
  type DocumentUpdate,
  clearSearchResults,
  getSearchResults,
  getStoredDocumentUpdates,
  storeDocumentUpdates,
  storeSearchResults,
} from 'services/document/document-store';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import { type ProcessedDocument, processDocument } from 'services/document/update-processor';
import { GithubService } from 'services/github';
import { type SlackMessage, getManagers, getUserName, getWorkspaceId } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import type { DocumentMetadata } from 'services/vector/types';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { applySelectedToGithubAction } from '../apply-document/update-documents';

/**
 * Create a link to the original message using Slack permalink format
 */
export function createMessageLink(workspaceUrl: string, channelId: string, messageTs?: string): string {
  // Remove trailing slash from workspace URL if present
  const baseUrl = workspaceUrl.replace(/\/$/, '');

  if (messageTs) {
    // Convert timestamp format (remove the dot)
    const encodedTs = messageTs.replace('.', '');
    return `${baseUrl}/archives/${channelId}/p${encodedTs}`;
  } else {
    return `${baseUrl}/archives/${channelId}`;
  }
}

/**
 * Show file selection dropdown before first suggestion
 */
async function showFileSelectionDropdown(
  client: any,
  userId: string,
  currentDmChannelId: string,
  searchResults: Document<DocumentMetadata>[],
  knowledgeContent: string,
  sessionId: string,
  knowledgeSourceChannelId?: string,
  knowledgeSourceThreadTs?: string,
  progressMessageTs?: string,
) {
  const workspaceId = await getWorkspaceId(client);
  const workspaceStore = new WorkspaceStore();
  const config = await workspaceStore.getWorkspaceConfig(workspaceId);

  if (!config || !config.githubRepo) {
    throw new Error('Workspace configuration or GitHub repository not found');
  }

  // Get writable files for file selection dropdown (excludes read-only files)
  let fileList = await workspaceStore.getWritableFiles(workspaceId);

  if (!fileList || fileList.length === 0) {
    // If no cached writable files, load from GitHub and cache, then filter
    const { owner, repo, path } = config.githubRepo;
    const githubService = GithubService.getInstance();
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner,
      repo,
      path,
      workspaceId: workspaceId,
      userId: userId,
    });

    // Cache all files
    await workspaceStore.setMarkdownFilesCache(workspaceId, markdownFiles.map((file) => ({
      name: file.name,
      path: file.path,
    })));

    // Get writable files after caching
    fileList = await workspaceStore.getWritableFiles(workspaceId);
  }

  // If no writable files available, show error
  if (!fileList || fileList.length === 0) {
    await client.chat.postEphemeral({
      channel: userId, // Use DM channel
      user: userId,
      text: '❌ No writable files available for document updates. All files are marked as read-only.',
    });
    return;
  }

  // Create file options for dropdown (only writable files)
  const fileOptions = fileList.map((file) => ({
    text: {
      type: 'plain_text' as const,
      text: file.name,
    },
    value: file.path,
  }));

  // Find the default file option (from first search result)
  const defaultFilePath = searchResults[0]?.metadata?.fileName || fileOptions[0]?.value;
  const defaultFileOption =
    fileOptions.find((option) => option.value === defaultFilePath || option.text.text === defaultFilePath) ||
    fileOptions[0];

  // Add (Recommended) to the default file option
  if (defaultFileOption) {
    defaultFileOption.text.text += ' (Recommended)';
  }

  const userName = await getUserName(userId, client);

  const fileSelectionBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📁 *Which file would you like to update?*',
      },
      block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
      accessory: {
        type: 'static_select',
        action_id: 'file_selection_for_update',
        placeholder: {
          type: 'plain_text',
          text: 'Choose a specific file...',
        },
        options: fileOptions,
        // initial_option 제거 - 기본값을 비워둠
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Start Review',
            emoji: false,
          },
          style: 'primary',
          action_id: 'start_file_based_review',
          value: JSON.stringify({
            sessionId,
            knowledgeContent,
            knowledgeSourceChannelId,
            knowledgeSourceThreadTs,
            selectedFile: null, // 기본값을 null로 설정
            defaultFilePath: defaultFilePath, // Recommended 파일 정보는 유지
          }),
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📄 Create New File',
            emoji: true,
          },
          action_id: 'show_create_file_modal',
          value: JSON.stringify({
            sessionId,
            knowledgeContent,
            knowledgeSourceChannelId,
            knowledgeSourceThreadTs,
          }),
        },
      ],
    },
  ];

  if (progressMessageTs) {
    // Try to update existing progress message with file selection UI
    try {
      await client.chat.update({
        channel: currentDmChannelId,
        ts: progressMessageTs,
        text: '📁 Which file would you like to update?',
        blocks: fileSelectionBlocks,
      });
      console.log(`Successfully updated progress message ${progressMessageTs} to file selection UI`);
      return progressMessageTs;
    } catch (updateError: any) {
      console.warn(`Failed to update progress message ${progressMessageTs}:`, updateError?.message || updateError);
      console.log('Falling back to creating new message for file selection');

      // Fallback to new message if update fails
      const message = await client.chat.postMessage({
        channel: currentDmChannelId,
        text: '📁 Which file would you like to update?',
        blocks: fileSelectionBlocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      return message.ts;
    }
  } else {
    // Create new message if no progress message timestamp
    console.log('No progress message timestamp available, creating new file selection message');
    const message = await client.chat.postMessage({
      channel: currentDmChannelId,
      text: '📁 Which file would you like to update?',
      blocks: fileSelectionBlocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    return message.ts;
  }
}

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

  // ========== CONCURRENCY CONTROL FOR MANAGER START UPDATE PROCESS ==========
  const value = body.actions?.[0]?.value;
  if (value) {
    try {
      const parsedValue = JSON.parse(value);
      const sessionId = parsedValue.sessionId;

      // Check if this is a manager starting the update process (not a continue action)
      // Only apply concurrency control for initial manager clicks, not subsequent actions
      if (
        sessionId &&
        !parsedValue.index &&
        !parsedValue.action &&
        !parsedValue.isFileBasedReview &&
        !parsedValue.selectedFile
      ) {
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;

        if (sessionData) {
          // Skip concurrency control if this manager is already processing
          if (sessionData.processingBy === userId) {
            logger.info(`Manager ${userId} is already processing session ${sessionId}, skipping concurrency check`);
          } else if (sessionData.status === 'processing') {
            // Different manager is processing
            const processingManagerName = sessionData.processingManagerName || 'Another manager';

            // Use response_url to show original message with disabled buttons + error message
            try {
              if (body.response_url) {
                // Reconstruct original message but with disabled buttons
                const originalBlocks = [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `Hi there! I'm CHOIR, your friendly documentation assistant. 👋\n\n*${sessionData.userName || 'A team member'}* has a suggestion for updating our documents, and I'm helping to pass it along for review.`,
                    },
                  },
                  {
                    type: 'header',
                    text: {
                      type: 'plain_text',
                      text: '📝 Document Update Suggestion',
                      emoji: true,
                    },
                  },
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `*From:* *${sessionData.userName || 'Unknown User'}*`,
                    },
                  },
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `*Suggestion:*\n\`\`\`${sessionData.extractedKnowledge || 'No content available'}\`\`\``,
                    },
                  },
                ];

                if (sessionData.originalMessageLink) {
                  originalBlocks.push({
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
                    },
                  });
                }

                // Add error message at the bottom
                originalBlocks.push({
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `❌ *Already being processed by ${processingManagerName}*`,
                  },
                });

                await fetch(body.response_url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    replace_original: true,
                    text: `❌ Already being processed by ${processingManagerName}`,
                    blocks: originalBlocks,
                  }),
                });
              }
            } catch (responseError) {
              logger.warn('Failed to send conflict message via response_url:', responseError);
            }

            logger.info(
              `Manager ${userId} tried to process session ${sessionId} but it's already being processed by ${sessionData.processingBy}`,
            );
            return;
          } else {
            // No one is processing yet, claim it
            const managerName = await getUserName(userId, client);
            sessionData.status = 'processing';
            sessionData.processingBy = userId;
            sessionData.processingManagerName = managerName;
            sessionData.processingAt = new Date().toISOString();
            storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

            logger.info(`Manager ${managerName} (${userId}) claimed processing for session ${sessionId}`);

            // Update other managers' messages to show conflict state
            await updateOtherManagerMessages(sessionData, userId, managerName, client, logger);

            // Notify original channel about who started processing
            await notifyOriginalChannel(sessionData, managerName, client, logger);
          }
        }
      }
    } catch (error) {
      logger.warn('Error in concurrency control:', error);
      // Continue with normal processing if concurrency control fails
    }
  }
  // ========== END CONCURRENCY CONTROL ==========

  try {
    if (messageTsOfButtonClicked && currentDmChannelId) {
      try {
        const history = await client.conversations.history({
          channel: currentDmChannelId,
          latest: messageTsOfButtonClicked,
          inclusive: true,
          limit: 1,
        });

        if (history.messages && history.messages.length > 0) {
          const originalMessage = history.messages[0];
          if (originalMessage.blocks) {
            const updatedBlocks = originalMessage.blocks.filter((block: any) => {
              // Remove actions blocks
              if (block.type === 'actions') {
                return false;
              }
              // Remove bonus idea sections (identified by text starting with 💡)
              if (block.type === 'section' && block.text?.text?.startsWith('💡')) {
                return false;
              }
              return true;
            });

            if (updatedBlocks.length < originalMessage.blocks.length) {
              await client.chat.update({
                channel: currentDmChannelId,
                ts: messageTsOfButtonClicked,
                text: originalMessage.text || '',
                blocks: updatedBlocks as any,
              });
              logger.info(
                `Updated message removing buttons ${messageTsOfButtonClicked} in channel ${currentDmChannelId}`,
              );
            } else {
              logger.info(`Buttons already removed or not found in message ${messageTsOfButtonClicked}`);
            }
          }
        }
      } catch (error: any) {
        // 익명 질문의 경우 channel_not_found 에러가 발생할 수 있음 - 무시하고 계속 진행
        if (error?.data?.error === 'channel_not_found') {
          logger.info(
            `Channel not found for message ${messageTsOfButtonClicked} - likely an anonymous question DM, continuing process`,
          );
        } else {
          logger.error(`Failed to update (remove buttons from) message ${messageTsOfButtonClicked}:`, error);
        }
      }
    }

    const lastMessageTs = getLastMessageTimestamp(userId);
    if (lastMessageTs && currentDmChannelId && lastMessageTs !== messageTsOfButtonClicked) {
      try {
        const history = await client.conversations.history({
          channel: currentDmChannelId,
          latest: lastMessageTs,
          inclusive: true,
          limit: 1,
        });

        if (history.messages && history.messages.length > 0) {
          const previousMessage = history.messages[0];
          if (previousMessage.blocks) {
            const updatedBlocks = previousMessage.blocks.filter((block: any) => {
              // Remove actions blocks
              if (block.type === 'actions') {
                return false;
              }
              // Remove bonus idea sections (identified by text starting with 💡)
              if (block.type === 'section' && block.text?.text?.startsWith('💡')) {
                return false;
              }
              return true;
            });
            if (updatedBlocks.length < previousMessage.blocks.length) {
              await client.chat.update({
                channel: currentDmChannelId,
                ts: lastMessageTs,
                text: previousMessage.text || '',
                blocks: updatedBlocks as any,
              });
            }
          }
        }
      } catch (error: any) {
        // 익명 질문의 경우 channel_not_found 에러가 발생할 수 있음 - 무시하고 계속 진행
        if (error?.data?.error === 'channel_not_found') {
          console.log(
            'Channel not found for previous suggestion message - likely an anonymous question DM, continuing process',
          );
        } else {
          console.error('Error updating previous suggestion message (removing buttons):', error);
        }
      }
    }

    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }
    const parsedValue = JSON.parse(value);

    let currentIndex = 0;
    let searchResults: Document<DocumentMetadata>[] = [];
    let isFirstSuggestion = true;
    let knowledgeContent = parsedValue.knowledgeContent;
    let sourceMessages: SlackMessage[] = [];
    const sessionId = parsedValue.sessionId;
    let isFileBasedReview = false;

    // If knowledgeContent is not in the button value, get it from session data
    if (!knowledgeContent && sessionId) {
      const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
      if (sessionData?.extractedKnowledge) {
        knowledgeContent = sessionData.extractedKnowledge;
        logger.info(`Retrieved knowledgeContent from session data for sessionId: ${sessionId}`);
      }
    }

    if (parsedValue.action === 'keep' || parsedValue.action === 'skip') {
      // Handle Skip This button with response_url
      if (parsedValue.action === 'skip') {
        logger.info(`User skipped suggestion ${currentIndex} for nodeId: ${parsedValue.currentNodeId}`);

        // Use response_url to replace the current message with skip confirmation
        const responseUrl = (body as any).response_url;
        if (responseUrl) {
          try {
            // Get current document info for better skip message using nodeId
            const currentDoc = searchResults.find(doc => doc.metadata?.nodeId === parsedValue.currentNodeId);
            const currentDocIndex = searchResults.findIndex(doc => doc.metadata?.nodeId === parsedValue.currentNodeId);
            const suggestionNumber = currentDocIndex + 1;
            const fileName = currentDoc?.metadata?.fileName || 'Unknown file';
            logger.info(`Skip message debug: found doc at index ${currentDocIndex}, suggestionNumber=${suggestionNumber}, fileName=${fileName}`);

            const response = await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                replace_original: true,
                text: `⏭️ Skipped suggestion ${suggestionNumber} for ${fileName}`,
                blocks: [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `⏭️ *Skipped* suggestion ${suggestionNumber} for ${fileName}`,
                    },
                  },
                ],
              }),
            });

            if (response.ok) {
              logger.info(`Successfully used response_url to show skip confirmation for suggestion ${currentIndex}`);
            } else {
              logger.warn(
                `Failed to use response_url for skip confirmation: ${response.status} ${response.statusText}`,
              );
            }
          } catch (responseUrlError) {
            logger.error('Error using response_url for skip confirmation:', responseUrlError);
            // Continue with normal flow if response_url fails
          }
        } else {
          logger.warn('No response_url available for skip confirmation');
        }
      }

      // shouldSwitchToAllFiles 로직 제거 - 이제 file-specific search에서 순서가 이미 정리됨

      if (sessionId) {
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        if (sessionData?.extractedKnowledge) {
          knowledgeContent = sessionData.extractedKnowledge;
        } else {
          logger.warn(
            `Extracted knowledge not found in session data for session ${sessionId} when action is "${parsedValue.action}". This might lead to issues if not handled elsewhere.`,
          );
        }
      } else {
        logger.error(`SessionId not found when action is '${parsedValue.action}'. Cannot retrieve knowledgeContent.`);
      }
    }

    let knowledgeSourceChannelId = parsedValue.originalChannelId;
    let knowledgeSourceThreadTs = parsedValue.originalThreadTs;

    if (!currentDmChannelId) {
      throw new Error('DM Channel ID not found in current context');
    }

    if (sessionId) {
      try {
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        console.log(`[DEBUG] Session data found:`, {
          sessionId,
          hasSourceMessages: !!sessionData?.sourceMessages,
          sourceMessagesLength: sessionData?.sourceMessages?.length || 0,
          hasMessages: !!sessionData?.messages,
          messagesLength: sessionData?.messages?.length || 0,
        });

        if (sessionData?.sourceMessages && sessionData.sourceMessages.length > 0) {
          sourceMessages = sessionData.sourceMessages;
          console.log(`[DEBUG] Using session sourceMessages:`, sourceMessages.length);
        } else if (sessionData?.messages && sessionData.messages.length > 0) {
          // sourceMessages가 없으면 일반 messages를 fallback으로 사용
          sourceMessages = sessionData.messages;
          console.log(`[DEBUG] Using session messages as fallback:`, sourceMessages.length);
        }

        if (!knowledgeSourceChannelId && sessionData?.originalChannelId)
          knowledgeSourceChannelId = sessionData.originalChannelId;
        if (!knowledgeSourceThreadTs && sessionData?.originalThreadTs)
          knowledgeSourceThreadTs = sessionData.originalThreadTs;
      } catch (error) {
        console.warn('Failed to get sourceMessages from sessionData:', error);
      }
    }

    if (sourceMessages.length === 0 && parsedValue.sourceMessages) {
      sourceMessages = parsedValue.sourceMessages;
      console.log(`[DEBUG] Using parsedValue sourceMessages:`, sourceMessages.length);
    }

    let validMessages: SlackMessage[];
    if (sourceMessages.length > 0) {
      // 실제 source messages가 있는 경우
      validMessages = sourceMessages;
      console.log(
        `[DEBUG] Using actual source messages:`,
        validMessages.map((m) => `${m.username}(${m.user || m.bot_id}): ${m.text?.substring(0, 50) || ''}...`),
      );
    } else {
      // source messages가 없는 경우: 실제 userId와 username 사용
      console.warn(`[DEBUG] No source messages found, creating fallback message with actual userId: ${userId}`);

      // 실제 사용자 이름 가져오기
      let actualUsername = 'User';
      try {
        const userInfo = await client.users.info({ user: userId });
        actualUsername = userInfo.user?.real_name || userInfo.user?.name || 'User';
      } catch (error) {
        console.warn('Failed to get username for fallback message:', error);
      }

      validMessages = [
        {
          userId: userId, // ✅ 실제 사용자 ID 사용
          username: actualUsername, // ✅ 실제 사용자 이름 사용
          text: `Knowledge extracted: ${knowledgeContent}`, // ✅ knowledge가 추출된 것임을 명시
          ts: Date.now().toString(),
        },
      ];
    }

    if (typeof parsedValue.index === 'number') {
      currentIndex = parsedValue.index;

      // Check if this is a file-based review
      if (parsedValue.isFileBasedReview && parsedValue.selectedFile) {
        logger.info(
          `Performing file-based search for file: ${parsedValue.selectedFile}, isFileBasedReview: ${parsedValue.isFileBasedReview}, isDefaultFile: ${parsedValue.isDefaultFile}`,
        );
        isFileBasedReview = true;

        // Perform search based on file selection - 3 cases
        if (parsedValue.selectedFile === 'ALL_FILES' || parsedValue.isDefaultFile) {
          // Case 1: ALL_FILES or default file - 항상 새로운 검색 수행
          logger.info('Performing fresh search (ALL_FILES or default file selected)');
          
          const workspaceId = await getWorkspaceId(client);
          searchResults = await vectorStore.similaritySearchWritableFiles(knowledgeContent, workspaceId, 5);

          // Log search results details
          logger.info(`=== SIMILARITY SEARCH RESULTS (ALL_FILES) ===`);
          logger.info(`Found ${searchResults.length} documents:`);
          searchResults.forEach((doc, index) => {
            logger.info(`[${index + 1}] File: ${doc.metadata?.fileName}, NodeId: ${doc.metadata?.nodeId}`);
            logger.info(`    Content: "${doc.pageContent.substring(0, 100)}..."`);
          });
          logger.info(`=== END SEARCH RESULTS ===`);
        } else {
          // Case 2: Different specific file - 파일별 검색만 수행
          logger.info(`Searching in specific file: ${parsedValue.selectedFile}`);
          const fileSpecificResults = await vectorStore.similaritySearchByFile(
            knowledgeContent,
            parsedValue.selectedFile,
            5, // 파일별 검색에서 최대 5개 결과
          );

          // Log file-specific search results
          logger.info(`=== FILE-SPECIFIC SEARCH RESULTS (${parsedValue.selectedFile}) ===`);
          logger.info(`Found ${fileSpecificResults.length} documents:`);
          fileSpecificResults.forEach((doc, index) => {
            logger.info(`[${index + 1}] File: ${doc.metadata?.fileName}, NodeId: ${doc.metadata?.nodeId}`);
            logger.info(`    Content: "${doc.pageContent.substring(0, 100)}..."`);
          });
          logger.info(`=== END FILE-SPECIFIC RESULTS ===`);

          // 파일별 검색 결과만 사용 (캐시 제거로 단순화)
          searchResults = fileSpecificResults;
          
          logger.info(`Using file-specific search results: ${searchResults.length} documents`);
        }

        // Check if we found any results
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
          return;
        }

        // For file-based review, we want to treat this as first suggestion UI-wise
        isFirstSuggestion = true;
      } else {
        logger.info(
          `Performing fresh search for continuation, isFileBasedReview: ${parsedValue.isFileBasedReview}, selectedFile: ${parsedValue.selectedFile}`,
        );
        // 캐시 제거로 항상 새로운 검색 수행
        const workspaceId = await getWorkspaceId(client);
        searchResults = await vectorStore.similaritySearchWritableFiles(knowledgeContent, workspaceId, 5);
        isFirstSuggestion = false;
      }

      // shouldSwitchToAllFiles 로직 제거됨

      if (parsedValue.action === 'keep' && parsedValue.currentNodeId) {
        const storedUpdates = getStoredDocumentUpdates(userId);
        // nodeId로 찾기 (index는 file-specific search 후 달라질 수 있음)
        const currentUpdate = storedUpdates.find((update) => update.nodeId === parsedValue.currentNodeId);

        if (!currentUpdate) {
          logger.error(
            `Could not find stored document update for nodeId ${parsedValue.currentNodeId}`,
          );

          await client.chat.postMessage({
            channel: currentDmChannelId!,
            text: '❌ Error: Could not retrieve the details for this update. Please try again or skip.',
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
                text: {
                  type: 'mrkdwn',
                  text: '❌ Error: Could not retrieve the details for this update. Please try again or skip.',
                },
              },
            ],
          });
          return;
        }

        const githubActionValue = {
          userId: userId,
          originalChannelId: currentUpdate.originalChannelId,
          originalThreadTs: currentUpdate.originalThreadTs,
          nodeId: currentUpdate.nodeId,
          suggestionType: currentUpdate.suggestionType,
          appendedNodeContent: currentUpdate.appendedNodeContent,
          originalLastNodeContent: currentUpdate.originalLastNodeContent,
          updatedNodeContent: currentUpdate.updatedNodeContent,
        };

        try {
          await applySelectedToGithubAction({
            ack: async () => {},
            body: {
              ...body,
              actions: [
                {
                  value: JSON.stringify(githubActionValue),
                },
              ],
            },
            client,
            logger,
          } as any);

          if (currentUpdate.originalChannelId && currentUpdate.nodeId) {
            try {
              const blocks = [];
              let notificationText = '';
              const sectionInfo = formatSectionPathWithLinks({
                headingPath: currentUpdate.headingPath,
                sectionName: currentUpdate.markdownSection,
                githubUrl: currentUpdate.githubUrl,
              } as any);

              // 업데이트한 사람 정보 (실제 Keep 버튼을 누른 manager)
              let updatedBy = 'User';
              try {
                const userInfo = await client.users.info({ user: userId });
                updatedBy = userInfo.user?.real_name || userInfo.user?.name || 'User';
              } catch (error) {
                console.error('Failed to get manager user info:', error);
                // fallback으로 messages에서 정보 확인
                if (currentUpdate.messages && currentUpdate.messages.length > 0) {
                  const lastMessage = currentUpdate.messages[currentUpdate.messages.length - 1];
                  updatedBy = lastMessage.username || 'User';
                }
              }

              // 통일된 알림 메시지
              notificationText = `✅ Document Updated by ${updatedBy}: <${currentUpdate.githubUrl}|${currentUpdate.fileName}> - ${sectionInfo}`;
              blocks.push({ type: 'section', text: { type: 'mrkdwn', text: notificationText } });

              // 항상 diff 블록 생성하여 변경사항 표시
              try {
                const { convertMarkdownToSlackText } = await import('services/document');
                const { createDiffBlock } = await import('services/slack');

                const oldSlackText = await convertMarkdownToSlackText(currentUpdate.nodeContent);
                const newSlackText = await convertMarkdownToSlackText(currentUpdate.updatedNodeContent);
                const updatedDiffBlock = createDiffBlock(oldSlackText, newSlackText);

                blocks.push(updatedDiffBlock);
              } catch (diffError) {
                console.error('Failed to create updated diff block:', diffError);
                // fallback으로 업데이트된 내용만 표시
                blocks.push({
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `*Updated Content:*\n\`\`\`${currentUpdate.updatedNodeContent}\`\`\``,
                  },
                });
              }

              await client.chat.postMessage({
                channel: currentUpdate.originalChannelId!,
                ...(currentUpdate.originalThreadTs ? { thread_ts: currentUpdate.originalThreadTs } : {}),
                text: notificationText,
                blocks: [
                  {
                    type: 'section',
                    block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
                    text: { type: 'mrkdwn', text: notificationText },
                  },
                  ...blocks.slice(1),
                ],
                unfurl_links: false,
                unfurl_media: false,
              });

              // Also notify other managers about this update
              await notifyOtherManagersAboutUpdate(
                currentUpdate,
                userId,
                updatedBy,
                notificationText,
                blocks,
                client,
                logger,
              );
            } catch (channelError) {
              console.error('Failed to post update to original channel:', channelError);
            }
          }
        } catch (error) {
          console.error('Failed to apply previous suggestion:', error);
        }
      }
    } else {
      isFirstSuggestion = true;
      currentIndex = 0;
      storeDocumentUpdates(userId, []);
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
    const loadingText =
      currentIndex === 0 && !isFileBasedReview
        ? '🔍 Finding relevant documents to update...'
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

    if (currentIndex === 0 && !isFileBasedReview) {
      const workspaceId = await getWorkspaceId(client);
      searchResults = await vectorStore.similaritySearchWritableFiles(knowledgeContent, workspaceId, 5);

      // Log search results details
      logger.info(`=== SIMILARITY SEARCH RESULTS (INITIAL SEARCH) ===`);
      logger.info(`Found ${searchResults?.length || 0} documents:`);
      searchResults?.forEach((doc, index) => {
        logger.info(`[${index + 1}] File: ${doc.metadata?.fileName}, NodeId: ${doc.metadata?.nodeId}`);
        logger.info(`    Content: "${doc.pageContent.substring(0, 100)}..."`);
      });
      logger.info(`=== END SEARCH RESULTS ===`);

      if (!searchResults || searchResults.length === 0) {
        // No search results, redirect to new section creation
        const allMarkdownFiles = vectorStore.getAllMarkdownFiles();
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

        const availableFiles = allMarkdownFiles.map((file) => ({
          fileName: file.name,
          githubUrl: file.githubUrl,
          description: `${file.name} - Documentation file`,
        }));

        try {
          const { createNewSectionFromKnowledge } = await import('services/llm/content-generator');
          const newSectionSuggestion = await createNewSectionFromKnowledge(knowledgeContent, availableFiles);

          if (newSectionSuggestion) {
            // Find the GitHub URL for the recommended file
            const recommendedFileInfo = availableFiles.find(
              (file) => file.fileName === newSectionSuggestion.recommendedFile,
            );
            const githubUrl = recommendedFileInfo?.githubUrl || availableFiles[0]?.githubUrl || '';

            // Store the new section data in session
            const newSectionSessionId = `new_section_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            storeSessionData(
              newSectionSessionId,
              {
                sectionTitle: newSectionSuggestion.sectionTitle,
                sectionContent: newSectionSuggestion.sectionContent,
                recommendedFile: newSectionSuggestion.recommendedFile,
                reasoning: newSectionSuggestion.reasoning,
                githubUrl: githubUrl,
                originalChannelId: knowledgeSourceChannelId,
                originalThreadTs: knowledgeSourceThreadTs,
                sessionId: sessionId,
              },
              SessionType.NEW_SECTION,
            );

            // Show new section creation modal directly
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
                      text: {
                        type: 'plain_text',
                        text: '📝 Create New Section',
                        emoji: true,
                      },
                      action_id: 'create_new_section',
                      value: JSON.stringify({
                        newSectionSessionId,
                        userId,
                      }),
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

        // Fallback if new section creation fails
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

      // Show file selection dropdown before first suggestion (update progress message)  
      const progressTimestamp = getProgressMessageTimestamp(userId);

      // Use the actual channel where progress message was created
      const progressChannel = progressMessage?.channel || currentDmChannelId;
      console.log(
        `[DEBUG] About to show file selection. progressTimestamp: ${progressTimestamp}, progressChannel: ${progressChannel}, currentDmChannelId: ${currentDmChannelId}`,
      );

      const fileSelectionMessageTs = await showFileSelectionDropdown(
        client,
        userId,
        progressChannel, // Use actual progress message channel
        searchResults,
        knowledgeContent,
        sessionId,
        knowledgeSourceChannelId,
        knowledgeSourceThreadTs,
        progressTimestamp,
      );

      console.log(
        `[DEBUG] File selection result. fileSelectionMessageTs: ${fileSelectionMessageTs}, was progressTimestamp used: ${!!progressTimestamp}`,
      );

      if (fileSelectionMessageTs) {
        setLastMessageTimestamp(userId, fileSelectionMessageTs);
      }

      // Clear progress message timestamp since it's now updated to file selection
      if (progressTimestamp) {
        deleteProgressMessageTimestamp(userId);
        console.log(`[DEBUG] Cleared progress message timestamp: ${progressTimestamp}`);
      }

      return; // Exit here, wait for user to select file and click "Start Review"
    }

    if (currentIndex >= searchResults.length) {
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
            text: {
              type: 'mrkdwn',
              text: "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",
            },
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      });

      return;
    }

    const currentDoc = searchResults[currentIndex];
    const processedDoc: ProcessedDocument | null = await processDocument(
      currentDoc,
      knowledgeContent,
      validMessages,
      client,
      vectorStore,
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
    };

    const currentUpdates = getStoredDocumentUpdates(userId);
    const existingUpdateIndex = currentUpdates.findIndex(
      (update) => update.nodeId === documentUpdateEntry.nodeId && update.index === currentIndex,
    );
    if (existingUpdateIndex >= 0) {
      currentUpdates[existingUpdateIndex] = documentUpdateEntry;
    } else {
      currentUpdates.push(documentUpdateEntry);
    }
    storeDocumentUpdates(userId, currentUpdates);

    const blocks: (KnownBlock | Block)[] = [];

    if (isFirstSuggestion) {
      // Skip introduction message since it was already shown in file selection dropdown
      // Original discussion link is handled by ui-builder.ts to avoid duplication
    }

    const suggestionNumber = currentIndex + 1;
    const sectionInfo = formatSectionPathWithLinks({
      headingPath: processedDoc.headingPath,
      sectionName: processedDoc.sectionName,
      githubUrl: processedDoc.githubUrl,
    } as DocumentMetadata);

    const suggestionTitleText = `📝 *Update Suggestion ${suggestionNumber}* : <${processedDoc.githubUrl}|${processedDoc.fileName}> - ${sectionInfo}`;

    const editButtonValue = {
      index: currentIndex,
      nodeId: processedDoc.nodeId,
      fileName: processedDoc.fileName,
      suggestionType: processedDoc.suggestionType,
      originalChannelId: knowledgeSourceChannelId,
      originalThreadTs: knowledgeSourceThreadTs,
      sessionId: sessionId,
    };

    const updateButtonValue = {
      index: currentIndex + 1,
      action: 'keep',
      sessionId: sessionId,
      currentNodeId: processedDoc.nodeId,
    };

    const skipButtonValue = {
      index: currentIndex + 1,
      action: 'skip',
      sessionId: sessionId,
      currentNodeId: processedDoc.nodeId,
    };

    const cancelButtonValue = {
      userId: userId,
      originalChannelId: knowledgeSourceChannelId,
      originalThreadTs: knowledgeSourceThreadTs,
      index: currentIndex,
      isFirstSuggestion: isFirstSuggestion,
      sessionId: sessionId,
      suggestionType: processedDoc.suggestionType,
    };

    // Main action buttons (Edit, Apply, Skip, Stop Review)
    const mainActionButtons = [
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Edit This', emoji: true },
        action_id: 'edit_update',
        value: JSON.stringify(editButtonValue),
      },
      {
        type: 'button' as const,
        text: {
          type: 'plain_text' as const,
          text: processedDoc.hasChanges ? '✅ Apply Changes' : '✅ Looks Good',
          emoji: true,
        },
        style: 'primary' as const,
        action_id: 'suggest_updates',
        value: JSON.stringify(updateButtonValue),
      },
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: '⏭️ Skip This', emoji: true },
        action_id: 'skip_suggestion',
        value: JSON.stringify(skipButtonValue),
      },
      {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Stop Review', emoji: false },
        style: 'danger' as const,
        action_id: 'cancel_document_updates',
        value: JSON.stringify(cancelButtonValue),
      },
    ];

    // Create New Section button (항상 표시)
    const newSectionButton = processedDoc.newSectionSuggestion
      ? {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: '💡 Create New Section', emoji: true },
          action_id: 'create_new_section',
          value: JSON.stringify(
            (() => {
              // 새 섹션 데이터를 세션에 저장
              const newSectionSessionId = `new_section_${userId}_${Date.now()}`;
              storeSessionData(
                newSectionSessionId,
                {
                  sectionTitle: processedDoc.newSectionSuggestion!.sectionTitle,
                  sectionContent: processedDoc.newSectionSuggestion!.sectionContent,
                  recommendedFile: processedDoc.newSectionSuggestion!.recommendedFile,
                  reasoning: processedDoc.newSectionSuggestion!.reasoning,
                  githubUrl: processedDoc.githubUrl,
                  originalChannelId: knowledgeSourceChannelId,
                  originalThreadTs: knowledgeSourceThreadTs,
                  sessionId: sessionId,
                },
                SessionType.NEW_SECTION,
              );

              // 버튼 value에는 sessionId만 저장
              return {
                newSectionSessionId,
                userId,
              };
            })(),
          ),
        }
      : null;

    // CHOIR의 통일된 설명 메시지
    let explanationText = '';
    if (processedDoc.hasChanges) {
      explanationText = `📝 I found content that could be *enhanced* based on your knowledge. I'm showing you the specific changes I'd recommend - you can see exactly what would be modified or added.`;
    } else {
      explanationText = `✅ Great news! This section is already well-aligned with your knowledge. I'm showing you the current content so you can verify it covers what you intended.`;
    }

    // 항상 새 섹션 제안 보너스 아이디어 표시
    let bonusIdeaText = '';
    if (processedDoc.newSectionSuggestion) {
      if (processedDoc.hasChanges) {
        bonusIdeaText = `💡 *Bonus idea:* I also think your knowledge would make a great standalone section! If you'd like, I can suggest creating a completely new section instead of updating the existing one. Just click the "Create New Section" button below to see my recommendation!`;
      } else {
        bonusIdeaText = `💡 *But here's a thought:* Even though this section is already well-aligned, your knowledge might deserve its own dedicated section! I can suggest where and how to create a new section for your content. Check out the "Create New Section" option below!`;
      }
    }

    blocks.push(
      {
        type: 'section',
        block_id: createCHOIRBlockId(CHOIRMessageType.DOCUMENT_SUGGESTION),
        text: { type: 'mrkdwn', text: suggestionTitleText },
      },
      { type: 'section', text: { type: 'mrkdwn', text: explanationText } },
      processedDoc.diffBlock,
      { type: 'actions', elements: mainActionButtons },
    );

    // Add bonus idea section and Create New Section button if available
    if (bonusIdeaText && newSectionButton) {
      blocks.push(
        { type: 'section', text: { type: 'mrkdwn', text: bonusIdeaText } },
        { type: 'actions', elements: [newSectionButton] },
      );
    }

    blocks.push({ type: 'divider' });

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
          channel: currentDmChannelId!,
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
        channel: currentDmChannelId!,
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
        storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);
      }
    }

    // 로그: 문서 업데이트 제안 성공
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      userId,
      workspaceId,
      currentDmChannelId || 'dm',
      'dm',
      'suggest_updates',
      Date.now() - startTime,
      true,
      {
        sessionId,
        currentIndex,
        isFirstSuggestion,
        suggestionType: processedDoc.suggestionType,
        fileName: processedDoc.fileName,
        hasChanges: processedDoc.hasChanges,
        searchResultsCount: searchResults.length,
        knowledgeContent: knowledgeContent || '',
        knowledgeContentLength: knowledgeContent?.length || 0,
        originalChannelId: knowledgeSourceChannelId,
        originalThreadTs: knowledgeSourceThreadTs,
      },
      client,
    );

    logger.info(`Document update suggestion ${currentIndex + 1} sent to user ${userId} for session ${sessionId}`);
  } catch (error) {
    console.error('suggestUpdatesCallback에서 오류:', error);

    // 로그: 문서 업데이트 제안 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      const value = body.actions?.[0]?.value;
      const parsedValue = value ? JSON.parse(value) : {};

      await logButtonClick(
        userId,
        workspaceId,
        currentDmChannelId || 'dm',
        'dm',
        'suggest_updates',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sessionId: parsedValue?.sessionId,
          currentIndex: parsedValue?.index || 0,
          isFirstSuggestion: parsedValue?.isFirstSuggestion || false,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log button click error:', logError);
    }

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
  }
};

/**
 * Notify other managers about document update results
 */
async function notifyOtherManagersAboutUpdate(
  _currentUpdate: any,
  currentManagerId: string,
  updatedBy: string,
  notificationText: string,
  blocks: any[],
  client: any,
  logger: any,
): Promise<void> {
  try {
    // Get workspace ID and managers list
    const workspaceId = await getWorkspaceId(client);
    const managers = await getManagers(workspaceId);

    // Filter out the current manager who performed the update
    const otherManagers = managers.filter((managerId) => managerId !== currentManagerId);

    if (otherManagers.length === 0) {
      logger.info('No other managers to notify about update');
      return;
    }

    // Send update notification to each other manager via DM
    const notificationPromises = otherManagers.map(async (managerId) => {
      try {
        await client.chat.postMessage({
          channel: managerId, // DM to manager
          text: `📝 Document Update by ${updatedBy}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📝 *Document Update Notification*\n\n${updatedBy} has updated a document that you were also reviewing.`,
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: notificationText },
            },
            ...blocks.slice(1), // Include diff and other blocks
          ],
          unfurl_links: false,
          unfurl_media: false,
        });
        logger.info(`Notified manager ${managerId} about document update by ${updatedBy}`);
      } catch (error) {
        logger.warn(`Failed to notify manager ${managerId} about update:`, error);
      }
    });

    await Promise.allSettled(notificationPromises);
    logger.info(`Update notification sent to ${otherManagers.length} other managers`);
  } catch (error) {
    logger.error('Error notifying other managers about update:', error);
  }
}

/**
 * Update other managers' messages to show that processing has started by another manager
 */
async function updateOtherManagerMessages(
  sessionData: any,
  currentManagerId: string,
  currentManagerName: string,
  client: any,
  logger: any,
): Promise<void> {
  if (!sessionData.managerMessageInfo) {
    logger.warn('No managerMessageInfo found in session data');
    return;
  }

  const updatePromises = Object.entries(sessionData.managerMessageInfo)
    .filter(([managerId]) => managerId !== currentManagerId)
    .map(async ([managerId, messageInfo]: [string, any]) => {
      try {
        const blocks: any[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Hi there! I'm CHOIR, your friendly documentation assistant. 👋\n\n*${sessionData.userName || 'A team member'}* has a suggestion for updating our documents, and I'm helping to pass it along for review.`,
            },
          },
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '📝 Document Update Suggestion',
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*From:* *${sessionData.userName || 'Unknown User'}*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Suggestion:*\n\`\`\`${sessionData.extractedKnowledge || 'No content available'}\`\`\``,
            },
          },
        ];

        if (sessionData.originalMessageLink) {
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
            },
          });
        }

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Processing started by ${currentManagerName}*`,
          },
        });

        await client.chat.update({
          channel: messageInfo.channel,
          ts: messageInfo.ts,
          text: `✅ Processing started by ${currentManagerName}`,
          blocks,
        });
        logger.info(`Updated message for manager ${managerId} - processing started by ${currentManagerName}`);
      } catch (error) {
        logger.warn(`Failed to update message for manager ${managerId}:`, error);
      }
    });

  await Promise.allSettled(updatePromises);
}

/**
 * Notify the original channel that processing has started and by whom
 */
async function notifyOriginalChannel(sessionData: any, managerName: string, client: any, logger: any): Promise<void> {
  if (!sessionData.originalChannelId) {
    logger.warn('No originalChannelId found in session data - skipping channel notification');
    return;
  }

  try {
    await client.chat.postMessage({
      channel: sessionData.originalChannelId,
      thread_ts: sessionData.originalThreadTs,
      text: `🔄 ${managerName} started processing your document update suggestion.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔄 *${managerName}* started processing your document update suggestion. You'll receive the document suggestions in your DM shortly! 📝`,
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    logger.info(`Notified original channel ${sessionData.originalChannelId} that ${managerName} started processing`);
  } catch (error) {
    logger.warn(`Failed to notify original channel ${sessionData.originalChannelId}:`, error);
  }
}

export default suggestUpdatesCallback;
