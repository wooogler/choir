import type { AllMiddlewareArgs, SlackViewAction, SlackViewMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logModalSubmit } from 'services/common/user-interaction-logger';
import { getChannelName, getManagers, getUserName, getWorkspaceId } from 'services/slack';

/**
 * Handle knowledge edit modal submission
 */
export async function handleKnowledgeEditModal({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<SlackViewAction>) {
  const startTime = Date.now();
  let workspaceId: string | undefined;
  await ack();

  try {
    workspaceId = await getWorkspaceId(client);
    const sessionId = body.view.private_metadata;

    if (!sessionId) {
      throw new Error('No session ID found in modal metadata');
    }

    // Get session data
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Session data not found. Please try the knowledge extraction again.',
      });

      // 로그: 세션 데이터 없음
      logModalSubmit(body.user.id, workspaceId || 'unknown', 'knowledge_edit_modal', Date.now() - startTime, false, {
        error: 'Session data not found',
        sessionId,
      });
      return;
    }

    // Get edited knowledge from modal input
    const stateValues = body.view.state.values;
    const editedKnowledge = stateValues.knowledge_input?.knowledge_text?.value;

    if (!editedKnowledge || editedKnowledge.trim() === '') {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Please provide some knowledge content before proceeding.',
      });

      // 로그: 빈 지식 내용
      logModalSubmit(body.user.id, workspaceId || 'unknown', 'knowledge_edit_modal', Date.now() - startTime, false, {
        error: 'Empty knowledge content',
        sessionId,
      });
      return;
    }

    // Update session data with edited knowledge
    sessionData.extractedKnowledge = editedKnowledge.trim();
    sessionData.lastEditedBy = body.user.id;
    sessionData.lastEditedAt = new Date().toISOString();

    // Store updated session data
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

    // Update the original preview message in the channel/thread
    try {
      // Get managers for the message
      const workspaceId = await getWorkspaceId(client);
      const managers = await getManagers(workspaceId);
      let managerText = 'managers';
      if (managers.length > 0) {
        // Get first manager's name as example
        const firstManagerName = await getUserName(managers[0], client);
        managerText = managers.length === 1 ? firstManagerName : `${firstManagerName} and other managers`;
      }

      // Find the original public message to update
      if (sessionData.publicMessageTs) {
        await client.chat.update({
          channel: sessionData.originalChannelId,
          ts: sessionData.publicMessageTs,
          text: `Sure! I'll suggest the following update to ${managerText}. (Edited)`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Sure! I'll suggest the following update to ${managerText}. *(Edited)*`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Suggested Update*\n\`\`\`${editedKnowledge.trim()}\`\`\``,
              },
            },
          ],
        });
      }
    } catch (updateError) {
      logger.warn('Failed to update original public message:', updateError);
      // Continue without sending DM if public message update fails
    }

    logger.info(`Knowledge edited by user ${body.user.id} for session ${sessionId}`);

    // 로그: 성공
    logModalSubmit(body.user.id, workspaceId || 'unknown', 'knowledge_edit_modal', Date.now() - startTime, true, {
      sessionId,
      originalChannelId: sessionData.originalChannelId,
      originalThreadTs: sessionData.originalThreadTs,
      editedKnowledgeLength: editedKnowledge.trim().length,
      publicMessageUpdated: !!sessionData.publicMessageTs,
    });
  } catch (error) {
    logger.error('Error processing knowledge edit modal:', error);

    await client.chat.postMessage({
      channel: body.user.id,
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

    logModalSubmit(body.user.id, workspaceId || 'unknown', 'knowledge_edit_modal', Date.now() - startTime, false, {
      error: error instanceof Error ? error.message : 'Unknown error',
      errorStack: error instanceof Error ? error.stack : undefined,
      sessionId: body.view.private_metadata,
    });
  }
}
