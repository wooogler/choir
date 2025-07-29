import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { getWorkspaceId } from 'services/slack';

/**
 * Show modal for creating a new file
 */
export const showCreateFileModalCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const createFileSessionId = body.actions[0].value;
    if (!createFileSessionId) {
      throw new Error('Action value is missing');
    }

    // Get data from session store to avoid 2001 character limit
    const sessionData = getSessionData(createFileSessionId, SessionType.CREATE_FILE_MODAL);
    if (!sessionData) {
      throw new Error('Session data not found or expired');
    }

    const { sessionId, defaultFileName, defaultInitialContent } = sessionData;

    const modal = {
      type: 'modal' as const,
      callback_id: 'create_file_modal',
      title: {
        type: 'plain_text' as const,
        text: 'Create New File',
      },
      submit: {
        type: 'plain_text' as const,
        text: 'Create File',
      },
      close: {
        type: 'plain_text' as const,
        text: 'Cancel',
      },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '📄 *Create a new markdown file in your repository*\n\nThis will create a new .md file in your GitHub repository and make it available for documentation updates.',
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'input',
          block_id: 'file_name_input',
          element: {
            type: 'plain_text_input',
            action_id: 'file_name',
            placeholder: {
              type: 'plain_text',
              text: 'e.g., new-documentation.md',
            },
            initial_value: defaultFileName || '',
          },
          label: {
            type: 'plain_text',
            text: 'File Name (must end with .md)',
          },
        },
        {
          type: 'input',
          block_id: 'file_content_input',
          element: {
            type: 'plain_text_input',
            action_id: 'file_content',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: '# New Documentation\n\nAdd your initial content here...',
            },
            initial_value: defaultInitialContent || '# New Documentation\n\nAdd your initial content here...',
          },
          label: {
            type: 'plain_text',
            text: 'Initial Content (Markdown)',
          },
        },
      ],
      private_metadata: JSON.stringify({
        createFileSessionId,
        userId: body.user.id,
        channelId: body.channel?.id,
      }),
    };

    await client.views.open({
      trigger_id: body.trigger_id,
      view: modal,
    });

    // 로그 기록
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || 'dm',
      'dm',
      'show_create_file_modal',
      Date.now() - startTime,
      true,
      {
        sessionId,
        createFileSessionId,
        defaultFileName: defaultFileName || '',
        defaultInitialContent: defaultInitialContent || '',
        defaultFileNameLength: (defaultFileName || '').length,
        defaultInitialContentLength: (defaultInitialContent || '').length,
        hasDefaultFileName: !!defaultFileName,
        hasDefaultInitialContent: !!defaultInitialContent,
      },
      client,
    );

    logger.info(`Create file modal shown for user ${body.user.id}, session ${sessionId}`);
  } catch (error) {
    logger.error('Error showing create file modal:', error);

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'dm',
        'dm',
        'show_create_file_modal',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          actionValue: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
