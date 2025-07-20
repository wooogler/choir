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
) {
  const workspaceId = await getWorkspaceId(client);
  const workspaceStore = new WorkspaceStore();
  const config = await workspaceStore.getWorkspaceConfig(workspaceId);

  if (!config || !config.githubRepo) {
    throw new Error('Workspace configuration or GitHub repository not found');
  }

  // Get available markdown files for file selection dropdown
  let fileList = await workspaceStore.getCachedMarkdownFiles(workspaceId);

  if (!fileList) {
    // If no cache, load from GitHub and cache the result
    const { owner, repo, path } = config.githubRepo;
    const githubService = GithubService.getInstance();
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner,
      repo,
      path,
      workspaceId: workspaceId,
      userId: userId,
    });

    fileList = markdownFiles.map((file) => ({
      name: file.name,
      path: file.path,
    }));

    // Cache the file list
    await workspaceStore.setMarkdownFilesCache(workspaceId, fileList);
  }

  // Create file options for dropdown
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

  const userName = await getUserName(userId, client);
  const message = await client.chat.postMessage({
    channel: currentDmChannelId,
    text: `👋 Hi *${userName}*! I'm CHOIR, your documentation assistant. I've analyzed your knowledge and found ${searchResults.length} relevant document${searchResults.length > 1 ? 's' : ''} that might need updates.`,
    blocks: [
      {
        type: 'section',
        block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
        text: {
          type: 'mrkdwn',
          text: `👋 Hi *${userName}*! I'm CHOIR, your documentation assistant. I've analyzed your knowledge and found ${searchResults.length} relevant document${searchResults.length > 1 ? 's' : ''} that might need updates.`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📁 *Which file would you like to focus on first?*\n\nI can either:\n• Review documents across all files (recommended)\n• Focus on a specific file of your choice`,
        },
        accessory: {
          type: 'static_select',
          action_id: 'file_selection_for_update',
          placeholder: {
            type: 'plain_text',
            text: 'Choose a file...',
          },
          initial_option: defaultFileOption,
          options: [
            {
              text: {
                type: 'plain_text',
                text: '🔍 All Files (Recommended)',
              },
              value: 'ALL_FILES',
            },
            ...fileOptions,
          ],
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Your Knowledge:*\n\`\`\`${knowledgeContent}\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '▶️ Start Review',
              emoji: true,
            },
            style: 'primary',
            action_id: 'start_file_based_review',
            value: JSON.stringify({
              sessionId,
              knowledgeContent,
              knowledgeSourceChannelId,
              knowledgeSourceThreadTs,
              selectedFile: 'ALL_FILES', // default selection
              defaultFilePath: defaultFilePath, // 기본 파일 정보 추가
            }),
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  });

  return message.ts;
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
              await client.chat.delete({
                channel: currentDmChannelId,
                ts: messageTsOfButtonClicked,
              });
              logger.info(`Deleted message with buttons ${messageTsOfButtonClicked} in channel ${currentDmChannelId}`);
            } else {
              logger.info(`Buttons already removed or not found in message ${messageTsOfButtonClicked}`);
            }
          }
        }
      } catch (error: any) {
        // 익명 질문의 경우 channel_not_found 에러가 발생할 수 있음 - 무시하고 계속 진행
        if (error?.data?.error === 'channel_not_found') {
          logger.info(`Channel not found for message ${messageTsOfButtonClicked} - likely an anonymous question DM, continuing process`);
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
              await client.chat.delete({
                channel: currentDmChannelId,
                ts: lastMessageTs,
              });
            }
          }
        }
      } catch (error: any) {
        // 익명 질문의 경우 channel_not_found 에러가 발생할 수 있음 - 무시하고 계속 진행
        if (error?.data?.error === 'channel_not_found') {
          console.log('Channel not found for previous suggestion message - likely an anonymous question DM, continuing process');
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

    if (parsedValue.action === 'keep') {
      // Apply Changes 후 특정 파일에서 전체 검토로 전환
      if (parsedValue.shouldSwitchToAllFiles) {
        logger.info('Switching from specific file review to all files review');
        isFileBasedReview = false; // 파일 기반 검토 종료
        // 저장된 5개 문서를 사용하도록 설정 (나중에 getSearchResults로 가져옴)
      }

      if (sessionId) {
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        if (sessionData?.extractedKnowledge) {
          knowledgeContent = sessionData.extractedKnowledge;
        } else {
          logger.warn(
            `Extracted knowledge not found in session data for session ${sessionId} when action is "keep". This might lead to issues if not handled elsewhere.`,
          );
        }
      } else {
        logger.error("SessionId not found when action is 'keep'. Cannot retrieve knowledgeContent.");
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
          // Case 1: ALL_FILES or default file - use stored 5 documents
          logger.info('Using stored search results (ALL_FILES or default file selected)');
          searchResults = getSearchResults(userId);

          // If no stored results, search for 5 documents
          if (!searchResults || searchResults.length === 0) {
            const allFilesResults = await vectorStore.similaritySearch(knowledgeContent, 5);
            searchResults = allFilesResults;
            storeSearchResults(userId, searchResults);
          }
        } else {
          // Case 2: Different specific file - search 1 document in that file
          logger.info(`Searching in specific file: ${parsedValue.selectedFile}`);
          const fileSpecificResults = await vectorStore.similaritySearchByFile(
            knowledgeContent,
            parsedValue.selectedFile,
            1,
          );
          searchResults = fileSpecificResults;
          // Don't store these results as they're file-specific
        }

        // Check if we found any results
        if (searchResults.length === 0) {
          // Delete progress message before showing error
          const progressTimestamp = getProgressMessageTimestamp(userId);
          if (progressTimestamp) {
            try {
              await client.chat.delete({
                channel: currentDmChannelId,
                ts: progressTimestamp,
              });
              deleteProgressMessageTimestamp(userId);
            } catch (deleteError) {
              console.error('진행 중 메시지 삭제 실패:', deleteError);
            }
          }
          
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
          `Using cached search results, isFileBasedReview: ${parsedValue.isFileBasedReview}, selectedFile: ${parsedValue.selectedFile}, shouldSwitchToAllFiles: ${parsedValue.shouldSwitchToAllFiles}`,
        );
        searchResults = getSearchResults(userId);
        isFirstSuggestion = false;
      }

      // Apply Changes 후 특정 파일에서 전체 검토로 전환된 경우 처리
      if (parsedValue.shouldSwitchToAllFiles && (!searchResults || searchResults.length === 0)) {
        logger.info('No cached results found after switching to all files, performing new search');
        const allFilesResults = await vectorStore.similaritySearch(knowledgeContent, 5);
        searchResults = allFilesResults;
        storeSearchResults(userId, searchResults);
      }

      if (parsedValue.action === 'keep' && parsedValue.currentNodeId) {
        const storedUpdates = getStoredDocumentUpdates(userId);
        const currentUpdate = storedUpdates.find(
          (update) => update.index === currentIndex - 1 && update.nodeId === parsedValue.currentNodeId,
        );

        if (!currentUpdate) {
          logger.error(
            `Could not find stored document update for index ${currentIndex - 1} and nodeId ${parsedValue.currentNodeId}`,
          );
          
          // Delete progress message before showing error
          const progressTimestamp = getProgressMessageTimestamp(userId);
          if (progressTimestamp) {
            try {
              await client.chat.delete({
                channel: currentDmChannelId!,
                ts: progressTimestamp,
              });
              deleteProgressMessageTimestamp(userId);
            } catch (deleteError) {
              console.error('진행 중 메시지 삭제 실패:', deleteError);
            }
          }
          
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

              if (currentUpdate.suggestionType === 'APPEND') {
                notificationText = `✅ New Content Appended by ${updatedBy}: <${currentUpdate.githubUrl}|${currentUpdate.fileName}> - ${sectionInfo}`;
                blocks.push({ type: 'section', text: { type: 'mrkdwn', text: notificationText } });

                // APPEND의 경우 새로 추가된 내용만 표시
                blocks.push({
                  type: 'section',
                  text: { type: 'mrkdwn', text: `*New Content:*\n\`\`\`${currentUpdate.appendedNodeContent}\`\`\`` },
                });
              } else {
                notificationText = `✅ Document Updated by ${updatedBy}: <${currentUpdate.githubUrl}|${currentUpdate.fileName}> - ${sectionInfo}`;
                blocks.push({ type: 'section', text: { type: 'mrkdwn', text: notificationText } });

                // UPDATE의 경우 manager가 수정한 최종 내용으로 새로운 diff 생성
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
      clearSearchResults(userId);
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

    if (isFirstSuggestion) {
      const progressMessage = await client.chat.postMessage({
        channel: currentDmChannelId,
        text: 'Preparing document update suggestions...',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
            text: { type: 'mrkdwn', text: 'Preparing document update suggestions...' },
          },
        ],
      });
      if (progressMessage.ts) {
        setProgressMessageTimestamp(userId, progressMessage.ts);
      }
    }

    if (currentIndex === 0 && !isFileBasedReview) {
      searchResults = await vectorStore.similaritySearch(knowledgeContent, 5);
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
            
            // Delete progress message before returning
            const progressTimestamp = getProgressMessageTimestamp(userId);
            if (progressTimestamp) {
              try {
                await client.chat.delete({
                  channel: currentDmChannelId,
                  ts: progressTimestamp,
                });
                deleteProgressMessageTimestamp(userId);
              } catch (deleteError) {
                console.error('진행 중 메시지 삭제 실패:', deleteError);
              }
            }
            
            return;
          }
        } catch (error) {
          console.error('Error creating new section when no search results found:', error);
        }

        // Delete progress message before showing fallback error
        const progressTimestamp = getProgressMessageTimestamp(userId);
        if (progressTimestamp) {
          try {
            await client.chat.delete({
              channel: currentDmChannelId,
              ts: progressTimestamp,
            });
            deleteProgressMessageTimestamp(userId);
          } catch (deleteError) {
            console.error('진행 중 메시지 삭제 실패:', deleteError);
          }
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

      // Show file selection dropdown before first suggestion
      storeSearchResults(userId, searchResults);
      const fileSelectionMessageTs = await showFileSelectionDropdown(
        client,
        userId,
        currentDmChannelId,
        searchResults,
        knowledgeContent,
        sessionId,
        knowledgeSourceChannelId,
        knowledgeSourceThreadTs,
      );
      if (fileSelectionMessageTs) {
        setLastMessageTimestamp(userId, fileSelectionMessageTs);
      }
      
      // Delete progress message before returning
      const progressTimestamp = getProgressMessageTimestamp(userId);
      if (progressTimestamp) {
        try {
          await client.chat.delete({
            channel: currentDmChannelId,
            ts: progressTimestamp,
          });
          deleteProgressMessageTimestamp(userId);
        } catch (deleteError) {
          console.error('진행 중 메시지 삭제 실패:', deleteError);
        }
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
      
      // Delete progress message before returning
      const progressTimestamp = getProgressMessageTimestamp(userId);
      if (progressTimestamp) {
        try {
          await client.chat.delete({
            channel: currentDmChannelId,
            ts: progressTimestamp,
          });
          deleteProgressMessageTimestamp(userId);
        } catch (deleteError) {
          console.error('진행 중 메시지 삭제 실패:', deleteError);
        }
      }
      
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

    // 진행 메시지 삭제 (공통 로직)
    const progressTimestamp = getProgressMessageTimestamp(userId);
    if (progressTimestamp) {
      try {
        await client.chat.delete({
          channel: currentDmChannelId,
          ts: progressTimestamp,
        });
        deleteProgressMessageTimestamp(userId);
      } catch (deleteError) {
        console.error('진행 중 메시지 삭제 실패:', deleteError);
      }
    }

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
      ...(processedDoc.suggestionType === 'APPEND' && {
        originalLastNodeContent: processedDoc.originalLastNodeContent,
        appendedNodeContent: processedDoc.appendedNodeContent,
        updatedNodeContent: processedDoc.originalLastNodeContent,
      }),
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

      // 원본 토론 링크 추가
      if (knowledgeSourceChannelId && sessionId) {
        const sessionDataForLink = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        const messageLink = sessionDataForLink?.originalMessageLink;

        if (messageLink) {
          try {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `📍 <${messageLink}|View original discussion> for context` },
            });
          } catch (linkError) {
            logger.warn(
              `Error adding original discussion link (already created) in suggestUpdatesCallback: ${linkError}`,
            );
          }
        } else {
          logger.warn(`originalMessageLink not found in sessionData for session ${sessionId}`);
        }
      } else if (!sessionId && knowledgeSourceChannelId) {
        const authInfo = await client.auth.test();
        const workspaceUrl = authInfo.url;
        if (workspaceUrl) {
          try {
            const convInfo = await client.conversations.info({ channel: knowledgeSourceChannelId });
            if (convInfo.ok && convInfo.channel && (!convInfo.channel.is_private || convInfo.channel.is_member)) {
              const fallbackMessageLink = createMessageLink(
                workspaceUrl,
                knowledgeSourceChannelId,
                knowledgeSourceThreadTs,
              );
              blocks.push({
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `📍 <${fallbackMessageLink}|View original discussion> for context (fallback link)`,
                },
              });
            }
          } catch (linkError) {
            logger.warn(`Could not create fallback original discussion link in suggestUpdatesCallback: ${linkError}`);
          }
        }
      }
      blocks.push({ type: 'divider' });
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
      ...(processedDoc.suggestionType === 'UPDATE' && {
        nodeContent: processedDoc.nodeContent,
        updatedNodeContent: processedDoc.updatedNodeContent,
      }),
      ...(processedDoc.suggestionType === 'APPEND' && {
        originalLastNodeContent: processedDoc.originalLastNodeContent,
        appendedNodeContent: processedDoc.appendedNodeContent,
      }),
    };

    const updateButtonValue = {
      index: currentIndex + 1,
      action: 'keep',
      sessionId: sessionId,
      currentNodeId: processedDoc.nodeId,
      // Apply Changes 후 특정 파일에서 전체 검토로 전환하는 로직
      shouldSwitchToAllFiles:
        isFileBasedReview && parsedValue.selectedFile !== 'ALL_FILES' && !parsedValue.isDefaultFile,
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

    // Main action buttons (Edit, Apply, Stop Review)
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
        text: { type: 'plain_text' as const, text: 'Stop Review', emoji: false },
        style: 'danger' as const,
        action_id: 'cancel_document_updates',
        value: JSON.stringify(cancelButtonValue),
      },
    ];

    // Create New Section button (separate actions block)
    const newSectionButton =
      processedDoc.suggestionType === 'APPEND' && processedDoc.newSectionSuggestion
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

    // CHOIR의 작업별 설명 메시지 (bonus idea 제외)
    let explanationText = '';
    if (processedDoc.suggestionType === 'APPEND') {
      if (processedDoc.hasChanges) {
        explanationText = `:mag: I found a section that could benefit from additional content based on your knowledge. I'm suggesting we append new information to the existing content rather than replacing it, since the current content is still valuable.`;
      } else {
        explanationText = `✅ I reviewed this section and it looks good! The existing content already covers what you mentioned, so no changes are needed here.`;
      }
    } else {
      if (processedDoc.hasChanges) {
        explanationText = `📝 I found some content that could be *updated* to better reflect your knowledge. I'm showing you the specific changes I'd recommend - you can see exactly what would be modified.`;
      } else {
        explanationText = `✅ Great news! This section is already up-to-date with your knowledge. I'm showing you the current content so you can verify it covers what you intended.`;
      }
    }

    // Separate bonus idea text for APPEND suggestions
    let bonusIdeaText = '';
    if (processedDoc.suggestionType === 'APPEND' && processedDoc.newSectionSuggestion) {
      if (processedDoc.hasChanges) {
        bonusIdeaText = `💡 *Bonus idea:* I also think your knowledge would make a great standalone section! If you'd like, I can suggest creating a completely new section instead of appending to the existing one. Just click the "Create New Section" button below to see my recommendation!`;
      } else {
        bonusIdeaText = `💡 *But here's a thought:* Even though this section is already complete, your knowledge might deserve its own dedicated section! I can suggest where and how to create a new section for your content. Check out the "Create New Section" option below!`;
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

    const result = await client.chat.postMessage({
      channel: currentDmChannelId!,
      blocks: blocks,
      unfurl_links: false,
      unfurl_media: false,
      text: 'Document Update Suggestions',
    });

    if (result.ts) {
      setLastMessageTimestamp(userId, result.ts);
    }

    // Store main message timestamp for Create New Section updates
    if (result.ts && sessionId && processedDoc.suggestionType === 'APPEND' && processedDoc.newSectionSuggestion) {
      const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
      if (sessionData) {
        sessionData.mainMessageTs = result.ts;
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

export default suggestUpdatesCallback;
