import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

/**
 * Handle "Edit Knowledge" button click from initial user submission
 */
export const editExtractedKnowledgeCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  let workspaceId: string | undefined;
  await ack();

  try {
    const sessionId = body.actions[0].value;

    if (!sessionId) {
      // Get workspace ID for logging
      try {
        workspaceId = await getWorkspaceId(client);
      } catch (workspaceError) {
        logger.warn('Failed to get workspace ID for logging:', workspaceError);
      }

      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Invalid session. Please try the knowledge extraction again.',
      });

      // 로그: 세션 ID 없음
      await logButtonClick(
        body.user.id,
        workspaceId || 'unknown',
        body.channel?.id || 'dm',
        'dm',
        'edit_extracted_knowledge',
        Date.now() - startTime,
        false,
        {
          error: 'No session ID provided',
        },
        client,
      );
      return;
    }

    workspaceId = await getWorkspaceId(client);

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Session data not found. Please try the knowledge extraction again.',
      });

      // 로그: 세션 데이터 없음
      await logButtonClick(
        body.user.id,
        workspaceId || 'unknown',
        body.channel?.id || 'dm',
        'dm',
        'edit_extracted_knowledge',
        Date.now() - startTime,
        false,
        {
          error: 'Session data not found',
          sessionId,
        },
        client,
      );
      return;
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'knowledge_edit_modal', // This ID is handled by handleKnowledgeEditModal
        notify_on_close: true,
        private_metadata: sessionId,
        title: {
          type: 'plain_text',
          text: 'Edit Knowledge',
          emoji: true,
        },
        submit: {
          type: 'plain_text',
          text: 'Update Knowledge',
          emoji: true,
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true,
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Edit the extracted knowledge before applying updates:* ',
            },
          },
          {
            type: 'input',
            block_id: 'knowledge_input',
            element: {
              type: 'plain_text_input',
              action_id: 'knowledge_text',
              multiline: true,
              initial_value: sessionData.extractedKnowledge || '',
              placeholder: {
                type: 'plain_text',
                text: 'Enter the knowledge to be documented...',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Knowledge Content',
              emoji: true,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `📊 *Source:* ${sessionData.messages?.length || 0} messages analyzed`,
              },
            ],
          },
        ],
      },
    });

    logger.info(`Knowledge edit modal opened for session ${sessionId}`);

    // 로그: 성공
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || 'dm',
      'dm',
      'edit_extracted_knowledge',
      Date.now() - startTime,
      true,
      {
        sessionId,
        originalChannelId: sessionData.originalChannelId,
        originalThreadTs: sessionData.originalThreadTs,
        extractedKnowledgeLength: sessionData.extractedKnowledge?.length || 0,
        messagesAnalyzed: sessionData.messages?.length || 0,
      },
      client,
    );
  } catch (error) {
    logger.error('Error opening knowledge edit modal:', error);

    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Failed to open edit modal. Please try again.',
    });

    // 로그: 실패
    if (!workspaceId) {
      try {
        workspaceId = await getWorkspaceId(client);
      } catch (workspaceError) {
        logger.warn('Failed to get workspace ID for logging:', workspaceError);
      }
    }

    try {
      const logWorkspaceId = workspaceId || (await getWorkspaceId(client));
      await logButtonClick(
        body.user.id,
        logWorkspaceId,
        body.channel?.id || 'dm',
        'dm',
        'edit_extracted_knowledge',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sessionId: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
