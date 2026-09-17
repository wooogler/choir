import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { deAnonymizeText } from 'services/common/name-cache';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';

export const viewAnalyzedMessagesAction = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // A modal only its opener sees.
  const t = tForRequest(context);

  try {
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const { sessionId, messageCount } = parsedValue;

    // Resolve the workspace up front so de-anonymization is scoped to it.
    const workspaceId = await getWorkspaceId(client);

    // Get messages from session data
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      throw new Error('Session data not found');
    }

    // Use processedMessages from session data if available, otherwise use original messages
    const messages = sessionData.processedMessages || sessionData.messages || [];

    // Create modal with analyzed messages
    const modal = {
      type: 'modal' as const,
      callback_id: 'view_analyzed_messages_modal',
      title: {
        type: 'plain_text' as const,
        text: t('docUpdate.actions.analyzed.title'),
      },
      close: {
        type: 'plain_text' as const,
        text: t('common.button.close'),
      },
      blocks: [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: t('docUpdate.actions.analyzed.summary', { sessionId, messageCount }),
          },
        },
        {
          type: 'divider' as const,
        },
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: t('docUpdate.actions.analyzed.listHeading'),
          },
        },
        ...messages.map((msg: any, index: number) => {
          // Handle both processedMessages format and original messages format
          let username = t('docUpdate.actions.analyzed.unknownUser');
          let text = t('docUpdate.actions.analyzed.noText');

          if (msg.role && msg.content) {
            // processedMessages format: { role: 'CHOIR' | 'user', content: 'Username: message' }
            if (msg.role === 'CHOIR') {
              username = 'CHOIR';
              text = msg.content.replace(/^CHOIR:\s*/, '');
            } else {
              // Extract username from "Username: message" format
              const colonIndex = msg.content.indexOf(':');
              if (colonIndex > 0) {
                username = msg.content.substring(0, colonIndex);
                text = msg.content.substring(colonIndex + 1).trim();
              } else {
                text = msg.content;
              }
            }
          } else {
            // Original messages format: { username: 'User', text: 'message' }
            username = msg.username || t('docUpdate.actions.analyzed.unknownUser');
            text = msg.text || t('docUpdate.actions.analyzed.noText');
          }

          const deAnonymizedUsername = deAnonymizeText(username, workspaceId);
          const deAnonymizedText = deAnonymizeText(text, workspaceId);

          return {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: t('docUpdate.actions.analyzed.item', {
                number: index + 1,
                username: deAnonymizedUsername,
                text: deAnonymizedText,
                ellipsis: deAnonymizedText.length >= 200 ? '...' : '',
              }),
            },
          };
        }),
      ],
    };

    if (!body.trigger_id) {
      throw new Error('Trigger ID not found');
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: modal,
    });

    // Log successful button click (workspaceId resolved above)
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || 'unknown',
      'public',
      'view_analyzed_messages',
      Date.now() - startTime,
      true,
      {
        sessionId,
        messageCount,
      },
      client,
    );

    logger.info(`User ${body.user.id} viewed analyzed messages for session ${sessionId}`);
  } catch (error) {
    logger.error('Error showing analyzed messages modal:', error);

    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'unknown',
        'public',
        'view_analyzed_messages',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log error:', logError);
    }

    // Send error message as ephemeral
    try {
      await client.chat.postEphemeral({
        channel: body.channel?.id || 'unknown',
        user: body.user.id,
        text: t('docUpdate.actions.analyzed.error', {
          reason: error instanceof Error ? error.message : 'Unknown error',
        }),
      });
    } catch (ephemeralError) {
      logger.error('Failed to send ephemeral error message:', ephemeralError);
    }
  }
};
