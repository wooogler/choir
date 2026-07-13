import { SessionType, getSessionData } from 'services/common';
import {
  getFileSelectionState,
  getStoredDocumentUpdates,
  markSuggestionAsApplied,
  resetFileSelectionAfterApply,
} from 'services/document/document-store';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { applySelectedToGithubAction } from '../../apply-document/apply-selected-to-github-action';
import { notifyOtherManagersAboutUpdate } from '../manager-notifications';

export async function handleKeep(params: {
  parsedValue: any;
  userId: string;
  currentWorkspaceId: string;
  currentDmChannelId: string;
  sessionId: string;
  body: any;
  client: any;
  logger: any;
}): Promise<void> {
  const { parsedValue, userId, currentWorkspaceId, currentDmChannelId, sessionId, body, client, logger } = params;

  const storedUpdates = getStoredDocumentUpdates(userId, currentWorkspaceId);
  const currentUpdate = storedUpdates.find((update) => update.nodeId === parsedValue.currentNodeId);

  if (!currentUpdate) {
    logger.error(`Could not find stored document update for nodeId ${parsedValue.currentNodeId}`);
    await client.chat.postMessage({
      channel: currentDmChannelId,
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
    userId,
    originalChannelId: currentUpdate.originalChannelId,
    originalThreadTs: currentUpdate.originalThreadTs,
    nodeId: currentUpdate.nodeId,
    suggestionType: currentUpdate.suggestionType,
    appendedNodeContent: currentUpdate.appendedNodeContent,
    originalLastNodeContent: currentUpdate.originalLastNodeContent,
    updatedNodeContent: currentUpdate.updatedNodeContent,
  };

  try {
    const applyResult = await applySelectedToGithubAction({
      ack: async () => {},
      body: {
        ...body,
        actions: [{ value: JSON.stringify(githubActionValue) }],
      },
      client,
      logger,
    } as any);

    // Only announce success and mark the suggestion applied if the GitHub commit
    // actually landed. applySelectedToGithubAction handles its own failure DM, so
    // a failed apply here must not broadcast "Document Updated" to the channel or
    // remove the suggestion from the manager's review queue.
    if (!applyResult?.success) {
      logger.warn(`GitHub apply did not succeed for node ${currentUpdate.nodeId}; skipping success broadcast`);
      return;
    }

    markSuggestionAsApplied(userId, parsedValue.currentNodeId, currentWorkspaceId);
    logger.info(`Marked suggestion ${parsedValue.currentNodeId} as applied for user ${userId}`);

    const originalChannelId = currentUpdate.originalChannelId;
    if (originalChannelId && currentUpdate.nodeId) {
      try {
        const blocks: any[] = [];
        const sectionInfo = formatSectionPathWithLinks({
          headingPath: currentUpdate.headingPath,
          sectionName: currentUpdate.markdownSection,
          githubUrl: currentUpdate.githubUrl,
        } as any);

        let updatedBy = 'User';
        try {
          const userInfo = await client.users.info({ user: userId });
          updatedBy = userInfo.user?.real_name || userInfo.user?.name || 'User';
        } catch (error) {
          console.error('Failed to get manager user info:', error);
          if (currentUpdate.messages && currentUpdate.messages.length > 0) {
            const lastMessage = currentUpdate.messages[currentUpdate.messages.length - 1];
            updatedBy = lastMessage.username || 'User';
          }
        }

        const notificationText = `✅ Document Updated by ${updatedBy}: <${currentUpdate.githubUrl}|${currentUpdate.fileName}> - ${sectionInfo}`;
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: notificationText } });

        try {
          const { convertMarkdownToSlackText } = await import('services/document');
          const { createDiffBlock } = await import('services/slack');
          const oldSlackText = await convertMarkdownToSlackText(currentUpdate.nodeContent);
          const newSlackText = await convertMarkdownToSlackText(currentUpdate.updatedNodeContent);
          blocks.push(createDiffBlock(oldSlackText, newSlackText));
        } catch (diffError) {
          console.error('Failed to create updated diff block:', diffError);
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Updated Content:*\n\`\`\`${currentUpdate.updatedNodeContent}\`\`\`` },
          });
        }

        await client.chat.postMessage({
          channel: originalChannelId,
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

        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        const isFromUserSuggestion = sessionData?.userId && sessionData.userId !== userId;

        if (isFromUserSuggestion) {
          await notifyOtherManagersAboutUpdate(
            currentUpdate,
            userId,
            updatedBy,
            notificationText,
            blocks,
            client,
            logger,
          );
          logger.info(
            `Notified other managers about update from user suggestion (original user: ${sessionData.userId})`,
          );
        } else {
          logger.info(`Skipped notifying other managers - this is manager's own work (manager: ${userId})`);
        }
      } catch (channelError) {
        console.error('Failed to post update to original channel:', channelError);
      }
    }

    const currentFileState = getFileSelectionState(userId, currentWorkspaceId);
    if (currentFileState?.isFileSelected) {
      resetFileSelectionAfterApply(userId, currentFileState.initialSearchResults, currentWorkspaceId);
    }
  } catch (error) {
    console.error('Failed to apply previous suggestion:', error);
  }
}
