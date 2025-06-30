import type { AllMiddlewareArgs, SlackViewAction, SlackViewMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logModalSubmit } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';
// import suggestUpdatesCallback from "../document-handlers/suggest-updates"; // Not used here
// import { SlackMessage } from "services/slack"; // Not used here

/**
 * Handle knowledge edit modal submission by a manager
 */
export async function handleKnowledgeEditManagerModal({
  ack,
  body,
  view,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<SlackViewAction>) {
  const startTime = Date.now();
  let workspaceId: string | undefined;
  await ack();
  const userId = body.user.id; // Manager's ID

  try {
    workspaceId = await getWorkspaceId(client);
    const sessionId = view.private_metadata;

    if (!sessionId) {
      throw new Error('No session ID found in modal metadata for manager edit');
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: userId,
        text: '❌ Session data not found. Please try again or ask the user to resubmit.',
      });

      // 로그: 세션 데이터 없음
      logModalSubmit(userId, workspaceId || 'unknown', 'knowledge_edit_manager_modal', Date.now() - startTime, false, {
        error: 'Session data not found',
        sessionId,
      });
      return;
    }

    const editedKnowledge = view.state.values.knowledge_input?.knowledge_text?.value;

    if (!editedKnowledge || editedKnowledge.trim() === '') {
      logger.warn('Manager tried to submit empty knowledge.');
      // No need to post message here as modal will show an error,
      // or we can choose to update the view with an error.
      // For now, just return, Slack might show a default error or nothing.

      // 로그: 빈 지식 내용
      logModalSubmit(userId, workspaceId || 'unknown', 'knowledge_edit_manager_modal', Date.now() - startTime, false, {
        error: 'Empty knowledge content',
        sessionId,
      });
      return;
    }

    // Update session data with edited knowledge and who edited it
    sessionData.extractedKnowledge = editedKnowledge.trim();
    sessionData.lastEditedBy = userId; // Mark manager as last editor
    sessionData.lastEditedAt = new Date().toISOString();
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

    logger.info(`Knowledge for session ${sessionId} edited by manager ${userId}`);

    const managerMessageInfo = sessionData.managerMessageInfo?.[userId];

    if (managerMessageInfo && managerMessageInfo.ts && managerMessageInfo.channel) {
      const blocks: any[] = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '📝 Document Update Suggestion', // Title remains same or can indicate edit
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*From:* <@${sessionData.userId}> (Original requester: ${sessionData.userName || 'Unknown User'})\n*Content:*\n\`\`\`${editedKnowledge.trim()}\`\`\``,
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
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Edit Knowledge',
              emoji: true,
            },
            action_id: 'open_knowledge_edit_manager_modal',
            value: sessionId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Start Document Update',
              emoji: true,
            },
            style: 'primary',
            action_id: 'suggest_updates',
            value: JSON.stringify({
              sessionId: sessionId,
              knowledgeContent: editedKnowledge.trim(),
              originalChannelId: sessionData.originalChannelId,
              originalThreadTs: sessionData.originalThreadTs,
            }),
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Dismiss',
              emoji: true,
            },
            style: 'danger',
            action_id: 'cancel_knowledge_extraction',
            value: sessionId,
          },
        ],
      });

      await client.chat.update({
        channel: managerMessageInfo.channel,
        ts: managerMessageInfo.ts,
        text: `Knowledge for session ${sessionId} was updated. Original requester: ${sessionData.userName || 'Unknown User'}`,
        blocks: blocks,
      });
    } else {
      logger.warn(
        `Original message info not found for manager ${userId} in session ${sessionId}. Cannot update the message. Posting a new one as fallback.`,
      );
      // Fallback: If somehow the original message info is lost, post a new message to the manager.
      // This new message will also have the "Edit Knowledge" button.
      const fallbackBlocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Knowledge Updated (Original Message Not Found):*\n\`\`\`${editedKnowledge.trim()}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Edit Knowledge',
                emoji: true,
              },
              action_id: 'open_knowledge_edit_manager_modal',
              value: sessionId,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Start Document Update',
                emoji: true,
              },
              style: 'primary',
              action_id: 'suggest_updates',
              value: JSON.stringify({
                sessionId: sessionId,
                knowledgeContent: editedKnowledge.trim(),
                originalChannelId: sessionData.originalChannelId,
                originalThreadTs: sessionData.originalThreadTs,
              }),
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Dismiss',
                emoji: true,
              },
              style: 'danger',
              action_id: 'cancel_knowledge_extraction',
              value: sessionId,
            },
          ],
        },
      ];
      if (sessionData.originalMessageLink) {
        fallbackBlocks.unshift({
          // Add link at the beginning if available
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
          },
        });
      }
      fallbackBlocks.unshift({
        type: 'header',
        text: {
          type: 'plain_text',
          text: '📝 Document Update Suggestion',
          emoji: true,
        },
      });
      fallbackBlocks.splice(1, 0, {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*From:* <@${sessionData.userId}> (Original requester: ${sessionData.userName || 'Unknown User'})`,
        },
      });

      await client.chat.postMessage({
        channel: userId,
        text: 'Knowledge updated. You can now start the document update process.',
        blocks: fallbackBlocks,
        unfurl_links: false,
        unfurl_media: false,
      });
    }

    // 로그: 성공
    logModalSubmit(userId, workspaceId || 'unknown', 'knowledge_edit_manager_modal', Date.now() - startTime, true, {
      sessionId,
      originalUserId: sessionData.userId,
      originalChannelId: sessionData.originalChannelId,
      originalThreadTs: sessionData.originalThreadTs,
      editedKnowledgeLength: editedKnowledge.trim().length,
      messageUpdated: !!(managerMessageInfo && managerMessageInfo.ts && managerMessageInfo.channel),
      fallbackMessageSent: !(managerMessageInfo && managerMessageInfo.ts && managerMessageInfo.channel),
    });
  } catch (error) {
    logger.error('Error processing manager knowledge edit modal:', error);
    await client.chat.postMessage({
      channel: userId, // Use manager's ID for error message
      text: `❌ Error processing knowledge edit: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });

    // 로그: 실패
    if (!workspaceId) {
      try {
        workspaceId = await getWorkspaceId(client);
      } catch (workspaceError) {
        logger.warn('Failed to get workspace ID for logging:', workspaceError);
      }
    }

    logModalSubmit(userId, workspaceId || 'unknown', 'knowledge_edit_manager_modal', Date.now() - startTime, false, {
      error: error instanceof Error ? error.message : 'Unknown error',
      errorStack: error instanceof Error ? error.stack : undefined,
      sessionId: view.private_metadata,
    });
  }
}
