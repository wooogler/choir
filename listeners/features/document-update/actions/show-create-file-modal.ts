import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';

/**
 * Show modal for creating a new file
 */
export const showCreateFileModalCallback = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // The receipt that replaces the button and the modal itself are both read by
  // the manager who clicked.
  const t = tForRequest(context);

  // Immediately update the message via response_url to remove the button
  const responseUrl = (body as any).response_url;
  if (responseUrl) {
    try {
      await fetch(responseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: t('docUpdate.actions.createFile.selected.fallback'),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('docUpdate.actions.createFile.selected'),
              },
            },
          ],
        }),
      });
      logger.info('Successfully updated Create New File button message via response_url');
    } catch (responseError) {
      logger.warn('Failed to update message via response_url:', responseError);
    }
  }

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
      notify_on_close: true,
      title: {
        type: 'plain_text' as const,
        text: t('docUpdate.actions.createFile.title'),
      },
      submit: {
        type: 'plain_text' as const,
        text: t('docUpdate.actions.createFile.submit'),
      },
      close: {
        type: 'plain_text' as const,
        text: t('common.button.cancel'),
      },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('docUpdate.actions.createFile.intro'),
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
              text: t('docUpdate.actions.createFile.name.placeholder'),
            },
            initial_value: defaultFileName || '',
          },
          label: {
            type: 'plain_text',
            text: t('docUpdate.actions.createFile.name.label'),
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
              text: t('docUpdate.actions.createFile.content.placeholder'),
            },
            initial_value: defaultInitialContent || t('docUpdate.actions.createFile.content.placeholder'),
          },
          label: {
            type: 'plain_text',
            text: t('docUpdate.actions.createFile.content.label'),
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
