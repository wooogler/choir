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
import { type SlackMessage, getManagers, getUserName, getWorkspaceId } from 'services/slack';
import { checkVectorStoreHealth } from 'services/vector/health-check';
import { VectorStoreService } from 'services/vector/main-service';
import type { DocumentMetadata } from 'services/vector/types';
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
            const textForUpdate =
              updatedBlocks.length < originalMessage.blocks.length
                ? `Processing... (Buttons removed)`
                : originalMessage.text || 'Processing document updates...';

            if (updatedBlocks.length < originalMessage.blocks.length) {
              await client.chat.update({
                channel: currentDmChannelId,
                ts: messageTsOfButtonClicked,
                blocks: updatedBlocks as (KnownBlock | Block)[],
                text: textForUpdate,
              });
              logger.info(`Removed buttons from message ${messageTsOfButtonClicked} in channel ${currentDmChannelId}`);
            } else {
              logger.info(`Buttons already removed or not found in message ${messageTsOfButtonClicked}`);
            }
          }
        }
      } catch (error) {
        logger.error(`Failed to update (remove buttons from) message ${messageTsOfButtonClicked}:`, error);
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
                blocks: updatedBlocks as (KnownBlock | Block)[],
                text: previousMessage.text || 'Previous suggestion (buttons removed)',
              });
            }
          }
        }
      } catch (error) {
        console.error('Error updating previous suggestion message (removing buttons):', error);
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

    if (parsedValue.action === 'keep') {
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
        validMessages.map((m) => `${m.username}(${m.userId}): ${m.text.substring(0, 50)}...`),
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
      searchResults = getSearchResults(userId);
      isFirstSuggestion = false;

      if (parsedValue.action === 'keep' && parsedValue.currentNodeId) {
        const storedUpdates = getStoredDocumentUpdates(userId);
        const currentUpdate = storedUpdates.find(
          (update) => update.index === currentIndex - 1 && update.nodeId === parsedValue.currentNodeId,
        );

        if (!currentUpdate) {
          logger.error(
            `Could not find stored document update for index ${currentIndex - 1} and nodeId ${parsedValue.currentNodeId}`,
          );
          await client.chat.postMessage({
            channel: currentDmChannelId!,
            text: '❌ Error: Could not retrieve the details for this update. Please try again or skip.',
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

              // 업데이트한 사람 정보
              let updatedBy = 'User';
              if (currentUpdate.messages && currentUpdate.messages.length > 0) {
                const lastMessage = currentUpdate.messages[currentUpdate.messages.length - 1];
                updatedBy = lastMessage.username;
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

                // UPDATE의 경우 diffblock 사용
                if (currentUpdate.diffBlock) {
                  blocks.push(currentUpdate.diffBlock);
                } else {
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
                blocks: blocks,
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
      });
      return;
    }

    if (isFirstSuggestion) {
      const progressMessage = await client.chat.postMessage({
        channel: currentDmChannelId,
        text: 'Preparing document update suggestions...',
      });
      if (progressMessage.ts) {
        setProgressMessageTimestamp(userId, progressMessage.ts);
      }
    }

    const healthCheckResult = await checkVectorStoreHealth(client, currentDmChannelId);
    if (!healthCheckResult.isHealthy) {
      // If vector store is empty (0 vectors), skip to new section creation instead of showing error
      const diagnosis = vectorStore.diagnoseVectorStore();
      if (diagnosis.details.vectorsCount === 0) {
        console.log('Vector store is empty, skipping to new section creation');

        // Create new section directly since there are no existing documents to update
        const allMarkdownFiles = vectorStore.getAllMarkdownFiles();
        if (allMarkdownFiles.length === 0) {
          await client.chat.postMessage({
            channel: currentDmChannelId,
            text: '📝 No documents found in your repository. Please connect a GitHub repository with markdown files first, or add some markdown files to your repository.',
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
            const emptyVectorStoreMessage = await client.chat.postMessage({
              channel: currentDmChannelId,
              text: `💡 Since you don't have any existing content in your vector store, I'll help you create a new section for this knowledge!`,
              blocks: [
                {
                  type: 'section',
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

            // Store message timestamp for later update
            if (emptyVectorStoreMessage.ts && sessionId) {
              const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
              if (sessionData) {
                sessionData.emptyVectorStoreMessageTs = emptyVectorStoreMessage.ts;
                sessionData.emptyVectorStoreChannelId = currentDmChannelId;
                storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);
              }
            }
            return;
          }
        } catch (error) {
          console.error('Error creating new section from empty vector store:', error);
        }
      }

      // For other health check failures, show the original error
      if (healthCheckResult.blocks) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          blocks: healthCheckResult.blocks,
        });
      } else if (healthCheckResult.message) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: healthCheckResult.message,
        });
      }
      return;
    }

    if (currentIndex === 0) {
      searchResults = await vectorStore.similaritySearch(knowledgeContent, 5);
      if (!searchResults || searchResults.length === 0) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: 'No relevant documents found for the extracted knowledge. Please try with different knowledge or contact an administrator.',
        });
        return;
      }
      storeSearchResults(userId, searchResults);
    }

    if (currentIndex >= searchResults.length) {
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",
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
      // CHOIR 소개 및 과정 설명
      const userName = await getUserName(userId, client);
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: `👋 Hi *${userName}*! I\'m CHOIR, your documentation assistant. I\'ve analyzed the knowledge you shared and found ${searchResults.length} relevant document${searchResults.length > 1 ? 's' : ''} that might need updates.\n\nI\'ll walk you through each document one by one, showing you exactly what changes I\'m suggesting and why. You can review, edit, or approve each suggestion - you\'re in full control of the process!`,
        unfurl_links: false,
        unfurl_media: false,
      });

      const headerText = 'Document Update';
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true },
      });

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Content:*\n\`\`\`${knowledgeContent}\`\`\`` },
      });

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
        explanationText = `🔍 I found a section that could benefit from additional content based on your knowledge. I'm suggesting we *append new information* to the existing content rather than replacing it, since the current content is still valuable.`;
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
      { type: 'section', text: { type: 'mrkdwn', text: suggestionTitleText } },
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
          text: `문서 업데이트 제안 중 오류가 발생했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`,
        });
      } catch (dmError) {
        console.error('DM 전송 오류:', dmError);
      }
    }
  }
};

export default suggestUpdatesCallback;
