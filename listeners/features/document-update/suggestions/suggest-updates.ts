import { Document } from "@langchain/core/documents";
import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import type { KnownBlock, Block } from "@slack/web-api";
import { processDocument, ProcessedDocument } from "services/document/update-processor";
import { 
  storeDocumentUpdates, 
  getSearchResults, 
  getStoredDocumentUpdates,
  DocumentUpdate,
  storeSearchResults,
  clearSearchResults
} from "services/document/document-store";
import { SlackMessage, getWorkspaceId, getManagers } from "services/slack";
import { checkVectorStoreHealth } from "services/vector/health-check";
import { VectorStoreService } from "services/vector/main-service";
import { DocumentMetadata } from "services/vector/types";
import { formatSectionPathWithLinks } from "services/document/section-utils";
import { 
  setLastMessageTimestamp, 
  getLastMessageTimestamp,
  setProgressMessageTimestamp,
  getProgressMessageTimestamp,
  deleteProgressMessageTimestamp
} from "services/common";
import { applySelectedToGithubAction } from "../apply-document/update-documents";
import { getSessionData, SessionType, storeSessionData } from "services/common";

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
  logger
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
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
          limit: 1
        });

        if (history.messages && history.messages.length > 0) {
          const originalMessage = history.messages[0];
          if (originalMessage.blocks) {
            const updatedBlocks = originalMessage.blocks.filter((block: any) => 
              block.type !== "actions"
            );
            const textForUpdate = updatedBlocks.length < originalMessage.blocks.length 
              ? `Processing... (Buttons removed)` 
              : originalMessage.text || "Processing document updates...";

            if (updatedBlocks.length < originalMessage.blocks.length) {
                await client.chat.update({
                    channel: currentDmChannelId,
                    ts: messageTsOfButtonClicked,
                    blocks: updatedBlocks as (KnownBlock | Block)[],
                    text: textForUpdate 
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
          limit: 1
        });

        if (history.messages && history.messages.length > 0) {
          const previousMessage = history.messages[0];
          if (previousMessage.blocks) {
            const updatedBlocks = previousMessage.blocks.filter((block: any) => 
              block.type !== "actions"
            );
            if (updatedBlocks.length < previousMessage.blocks.length) {
                await client.chat.update({
                    channel: currentDmChannelId,
                    ts: lastMessageTs,
                    blocks: updatedBlocks as (KnownBlock | Block)[],
                    text: previousMessage.text || "Previous suggestion (buttons removed)"
                });
            }
          }
        }
      } catch (error) {
        console.error("Error updating previous suggestion message (removing buttons):", error);
      }
    }
    
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error("Button value not found");
    }
    const parsedValue = JSON.parse(value);

    let currentIndex = 0;
    let searchResults: Document<DocumentMetadata>[] = [];
    let isFirstSuggestion = true;
    let knowledgeContent = parsedValue.knowledgeContent;
    let sourceMessages: SlackMessage[] = [];
    let sessionId = parsedValue.sessionId;

    if (parsedValue.action === "keep") {
      if (sessionId) {
        const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
        if (sessionData?.extractedKnowledge) {
          knowledgeContent = sessionData.extractedKnowledge;
        } else {
          logger.warn(`Extracted knowledge not found in session data for session ${sessionId} when action is "keep". This might lead to issues if not handled elsewhere.`);
        }
      } else {
        logger.error("SessionId not found when action is 'keep'. Cannot retrieve knowledgeContent.");
      }
    }

    let knowledgeSourceChannelId = parsedValue.originalChannelId;
    let knowledgeSourceThreadTs = parsedValue.originalThreadTs;

    if (!currentDmChannelId) {
      throw new Error("DM Channel ID not found in current context");
    }

    if (sessionId) {
      try {
        const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
        if (sessionData?.sourceMessages) {
          sourceMessages = sessionData.sourceMessages;
        }
        if (!knowledgeSourceChannelId && sessionData?.originalChannelId) knowledgeSourceChannelId = sessionData.originalChannelId;
        if (!knowledgeSourceThreadTs && sessionData?.originalThreadTs) knowledgeSourceThreadTs = sessionData.originalThreadTs;

      } catch (error) {
        console.warn("Failed to get sourceMessages from sessionData:", error);
      }
    }
    if (sourceMessages.length === 0 && parsedValue.sourceMessages) {
      sourceMessages = parsedValue.sourceMessages;
    }

    if (typeof parsedValue.index === 'number') { 
      currentIndex = parsedValue.index;
      searchResults = getSearchResults(userId);
      isFirstSuggestion = false; 
      
      if (parsedValue.action === "keep" && parsedValue.currentNodeId) {
        const storedUpdates = getStoredDocumentUpdates(userId);
        const currentUpdate = storedUpdates.find(update => update.index === (currentIndex - 1) && update.nodeId === parsedValue.currentNodeId);

        if (!currentUpdate) {
          logger.error(`Could not find stored document update for index ${currentIndex -1} and nodeId ${parsedValue.currentNodeId}`);
          await client.chat.postMessage({
            channel: currentDmChannelId!,
            text: "❌ Error: Could not retrieve the details for this update. Please try again or skip."
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
          updatedNodeContent: currentUpdate.updatedNodeContent 
        };

        try {
          await applySelectedToGithubAction({
            ack: async () => {},
            body: {
              ...body,
              actions: [{
                value: JSON.stringify(githubActionValue)
              }]
            },
            client,
            logger
          } as any);

          if (currentUpdate.originalChannelId && currentUpdate.nodeId) {
            try {
              let blocks = [];
              let notificationText = "";
              const sectionInfo = formatSectionPathWithLinks({
                headingPath: currentUpdate.headingPath,
                sectionName: currentUpdate.markdownSection,
                githubUrl: currentUpdate.githubUrl
              } as any);

              if (currentUpdate.suggestionType === "APPEND") {
                notificationText = `✅ New Content Appended: ${currentUpdate.fileName}`;
                blocks.push(
                  { type: "section", text: { type: "mrkdwn", text: `✅ *New Content Appended to Document*\n*File:* <${currentUpdate.githubUrl}|${currentUpdate.fileName}>\n*Section:* ${sectionInfo}` } }
                );
              } else {
                notificationText = `✅ Document Updated: ${currentUpdate.fileName}`;
                blocks.push(
                  { type: "section", text: { type: "mrkdwn", text: `✅ *Document Updated*\n*File:* <${currentUpdate.githubUrl}|${currentUpdate.fileName}>\n*Section:* ${sectionInfo}` } }
                );
              }

              blocks.push(
                { type: "section", text: { type: "mrkdwn", text: notificationText } }
              );

              await client.chat.postMessage({
                channel: currentUpdate.originalChannelId!,
                ...(currentUpdate.originalThreadTs ? { thread_ts: currentUpdate.originalThreadTs } : {}),
                text: notificationText,
                blocks: blocks,
                unfurl_links: false,
                unfurl_media: false
              });
            } catch (channelError) {
              console.error("Failed to post update to original channel:", channelError);
            }
          }
        } catch (error) {
          console.error("Failed to apply previous suggestion:", error);
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
        text: "No knowledge content found. Please try again.",
      });
      return;
    }

    const validMessages: SlackMessage[] = sourceMessages.length > 0 
      ? sourceMessages 
      : [{
          userId: "knowledge_extraction",
          username: "Knowledge Extraction",
          text: knowledgeContent,
          ts: Date.now().toString()
        }];

    if (isFirstSuggestion) {
        const progressMessage = await client.chat.postMessage({
            channel: currentDmChannelId,
            text: "Preparing document update suggestions...",
        });
        if (progressMessage.ts) {
            setProgressMessageTimestamp(userId, progressMessage.ts);
        }
    }

    const healthCheckResult = await checkVectorStoreHealth(client, currentDmChannelId);
    if (!healthCheckResult.isHealthy) {
      if (healthCheckResult.blocks) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          blocks: healthCheckResult.blocks
        });
      } else if (healthCheckResult.message) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: healthCheckResult.message
        });
      }
      return;
    }

    if (currentIndex === 0) {
      searchResults = await vectorStore.similaritySearch(knowledgeContent, 5);
      if (!searchResults || searchResults.length === 0) {
        await client.chat.postMessage({
          channel: currentDmChannelId,
          text: "No relevant documents found for the extracted knowledge. Please try with different knowledge or contact an administrator.",
        });
        return;
      }
      storeSearchResults(userId, searchResults);
    }

    if (currentIndex >= searchResults.length) {
      await client.chat.postMessage({
        channel: currentDmChannelId,
        text: "No more documents to update.",
      });
      return;
    }

    const currentDoc = searchResults[currentIndex];
    const processedDoc: ProcessedDocument | null = await processDocument(currentDoc, knowledgeContent, validMessages, client, vectorStore);

    if (!processedDoc || !processedDoc.hasChanges) {
      const progressTs = getProgressMessageTimestamp(userId);
      if (progressTs) {
        try {
          await client.chat.delete({
            channel: currentDmChannelId,
            ts: progressTs
          });
          deleteProgressMessageTimestamp(userId);
        } catch (deleteError) {
          console.error("진행 중 메시지 삭제 실패:", deleteError);
        }
      }
      
      await suggestUpdatesCallback({
        ack: async () => {},
        body: {
          ...body,
          actions: [{
            value: JSON.stringify({
              index: currentIndex + 1,
              originalChannelId: knowledgeSourceChannelId,
              originalThreadTs: knowledgeSourceThreadTs,
              ...(parsedValue.action !== "keep" && { knowledgeContent: knowledgeContent }),
              sessionId: sessionId
            })
          }]
        },
        client,
        logger
      } as any);
      return;
    }

    const documentUpdateEntry: DocumentUpdate = {
      index: currentIndex,
      fileName: processedDoc.fileName,
      githubUrl: processedDoc.githubUrl,
      markdownSection: processedDoc.sectionName || "Main Content",
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
      ...(processedDoc.suggestionType === "APPEND" && {
        originalLastNodeContent: processedDoc.originalLastNodeContent,
        appendedNodeContent: processedDoc.appendedNodeContent,
        updatedNodeContent: processedDoc.originalLastNodeContent,
      })
    };
    
    const currentUpdates = getStoredDocumentUpdates(userId);
    const existingUpdateIndex = currentUpdates.findIndex(update => update.nodeId === documentUpdateEntry.nodeId && update.index === currentIndex);
    if (existingUpdateIndex >= 0) {
      currentUpdates[existingUpdateIndex] = documentUpdateEntry;
    } else {
      currentUpdates.push(documentUpdateEntry);
    }
    storeDocumentUpdates(userId, currentUpdates);

    const blocks: (KnownBlock | Block)[] = [];

    if (isFirstSuggestion) {
      let headerText = "Document Update";
      if (sessionId) {
        const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
        if (sessionData && sessionData.userName) {
          headerText = `Document Update from ${sessionData.userName}`;
        } else if (sessionData && sessionData.userId) {
          // Fallback to userId if userName is not available for some reason
          headerText = `Document Update from <@${sessionData.userId}>`;
        }
      }
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: headerText, emoji: true }
      });

      // OR if it's the very first interaction (no previous message from passKnowledgeToManager)
      // For now, simplify: if isManagerDMContext, these were in the preceding message from passKnowledgeToManager.
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Content:*
\`\`\`${knowledgeContent}\`\`\`` }
      });
      // Ensure sessionId is valid before trying to get sessionDataForLink
      if (knowledgeSourceChannelId && sessionId) { 
        const sessionDataForLink = getSessionData(sessionId, SessionType.CONSULTATION) as any;
        const messageLink = sessionDataForLink?.originalMessageLink;

        if (messageLink) {
            try {
                blocks.push({
                    type: "section",
                    text: { type: "mrkdwn", text: `📍 <${messageLink}|View original discussion> for context` }
                });
            } catch (linkError) {
                logger.warn(`Error adding original discussion link (already created) in suggestUpdatesCallback: ${linkError}`);
            }
        } else {
            logger.warn(`originalMessageLink not found in sessionData for session ${sessionId}`);
        }
      } else if (!sessionId && knowledgeSourceChannelId) {
        // Fallback to creating link if sessionId is not available but knowledgesourcechannelId is.
        // This case might be rare if flow always includes sessionId for managers.
        const authInfo = await client.auth.test();
        const workspaceUrl = authInfo.url;
        if (workspaceUrl) {
            try {
                const convInfo = await client.conversations.info({ channel: knowledgeSourceChannelId });
                if (convInfo.ok && convInfo.channel && (!convInfo.channel.is_private || convInfo.channel.is_member)) {
                    const fallbackMessageLink = createMessageLink(workspaceUrl, knowledgeSourceChannelId, knowledgeSourceThreadTs);
                    blocks.push({
                        type: "section",
                        text: { type: "mrkdwn", text: `📍 <${fallbackMessageLink}|View original discussion> for context (fallback link)` }
                    });
                }
            } catch (linkError) {
                logger.warn(`Could not create fallback original discussion link in suggestUpdatesCallback: ${linkError}`);
            }
        }
      }
      blocks.push({ type: "divider" });
    }

    const suggestionNumber = currentIndex + 1;
    const sectionInfo = formatSectionPathWithLinks({
      headingPath: processedDoc.headingPath,
      sectionName: processedDoc.sectionName,
      githubUrl: processedDoc.githubUrl
    } as DocumentMetadata);
    
    let suggestionTitleText = "";
    if (processedDoc.suggestionType === "APPEND") {
      suggestionTitleText = `🆕 *New Content Suggestion (Append) ${suggestionNumber}* : <${processedDoc.githubUrl}|${processedDoc.fileName}> - ${sectionInfo}`;
    } else {
      suggestionTitleText = `📝 *Update Suggestion ${suggestionNumber}* : <${processedDoc.githubUrl}|${processedDoc.fileName}> - ${sectionInfo}`;
    }

    const editButtonValue = {
      index: currentIndex,
      nodeId: processedDoc.nodeId,
      fileName: processedDoc.fileName,
      suggestionType: processedDoc.suggestionType,
      originalChannelId: knowledgeSourceChannelId,
      originalThreadTs: knowledgeSourceThreadTs,
      sessionId: sessionId,
      ...(processedDoc.suggestionType === "UPDATE" && {
        nodeContent: processedDoc.nodeContent,
        updatedNodeContent: processedDoc.updatedNodeContent
      }),
      ...(processedDoc.suggestionType === "APPEND" && {
        originalLastNodeContent: processedDoc.originalLastNodeContent,
        appendedNodeContent: processedDoc.appendedNodeContent
      })
    };

    const updateButtonValue = {
      index: currentIndex + 1, 
      action: "keep",
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
      suggestionType: processedDoc.suggestionType
    };

    const actionButtons = [
        { type: "button" as "button", text: { type: "plain_text" as "plain_text", text: "Edit", emoji: true }, action_id: "edit_update", value: JSON.stringify(editButtonValue) },
        { type: "button" as "button", text: { type: "plain_text" as "plain_text", text: processedDoc.suggestionType === "APPEND" ? "Append to Document" : "Update Document", emoji: true }, style: "primary" as "primary", action_id: "suggest_updates", value: JSON.stringify(updateButtonValue) },
        { type: "button" as "button", text: { type: "plain_text" as "plain_text", text: "Skip / Reject", emoji: true }, style: "danger" as "danger", action_id: "cancel_document_updates", value: JSON.stringify(cancelButtonValue) }
    ];

    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: suggestionTitleText } },
      processedDoc.diffBlock,
      { type: "actions", elements: actionButtons }
    );

    const progressTs = getProgressMessageTimestamp(userId);
    if (progressTs) {
      try {
        await client.chat.delete({
          channel: currentDmChannelId,
          ts: progressTs
        });
        deleteProgressMessageTimestamp(userId);
      } catch (deleteError) {
        console.error("진행 중 메시지 삭제 실패:", deleteError);
      }
    }

    const result = await client.chat.postMessage({
      channel: currentDmChannelId!,
      blocks: blocks,
      unfurl_links: false,
      unfurl_media: false,
      text: "Document Update Suggestions"
    });

    if (result.ts) {
      setLastMessageTimestamp(userId, result.ts);
    }

  } catch (error) {
    console.error("suggestUpdatesCallback에서 오류:", error);
    if (currentDmChannelId) {
        try {
            await client.chat.postMessage({
                channel: currentDmChannelId,
                text: `문서 업데이트 제안 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
            });
        } catch (dmError) {
            console.error("DM 전송 오류:", dmError);
        }
    }
  }
};

export default suggestUpdatesCallback;