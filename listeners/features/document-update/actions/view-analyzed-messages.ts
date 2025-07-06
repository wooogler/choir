import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

export const viewAnalyzedMessagesAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const { sessionId, messageCount, messages } = parsedValue;

    // Create modal with analyzed messages
    const modal = {
      type: 'modal' as const,
      callback_id: 'view_analyzed_messages_modal',
      title: {
        type: 'plain_text' as const,
        text: 'Analyzed Messages',
      },
      close: {
        type: 'plain_text' as const,
        text: 'Close',
      },
      blocks: [
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: `📊 *Analysis Summary*\n• Session ID: \`${sessionId}\`\n• Total messages: ${messageCount}`,
          },
        },
        {
          type: 'divider' as const,
        },
        {
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: '*📝 Messages analyzed for knowledge extraction:*',
          },
        },
        ...messages.map((msg: any, index: number) => ({
          type: 'section' as const,
          text: {
            type: 'mrkdwn' as const,
            text: `*${index + 1}. ${msg.username}*\n${msg.text}${msg.text.length >= 200 ? '...' : ''}`,
          },
        })),
      ],
    };

    if (!body.trigger_id) {
      throw new Error('Trigger ID not found');
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: modal,
    });

    // Log successful button click
    const workspaceId = await getWorkspaceId(client);
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
        text: `❌ Failed to show analyzed messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } catch (ephemeralError) {
      logger.error('Failed to send ephemeral error message:', ephemeralError);
    }
  }
};
