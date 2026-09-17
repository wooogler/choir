import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { describeError, tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';

export const getEditLinkAction = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // Everything here — the modal, the DM, the failure notice — is read by the
  // person who pressed the button.
  const t = tForRequest(context);

  try {
    const modalSessionId = body.actions?.[0]?.value;
    if (!modalSessionId) {
      throw new Error('Button value not found');
    }

    // Get data from session store instead of parsing button value
    const sessionData = getSessionData(modalSessionId, SessionType.NEW_SECTION);
    if (!sessionData) {
      throw new Error('Session data not found');
    }

    const { owner, repo, branch, fileOptions } = sessionData;

    if (!owner || !repo || !branch || !fileOptions) {
      throw new Error('Missing repository information');
    }

    // Get the current form values to determine which file was selected
    const view = body.view;
    if (!view?.state?.values) {
      throw new Error('Modal state not found');
    }

    const selectedFilePath = view.state.values.file_selection_input?.file_selection?.selected_option?.value;
    if (!selectedFilePath) {
      await client.chat.postEphemeral({
        channel: body.user.id,
        user: body.user.id,
        text: t('docUpdate.actions.editLink.selectFirst'),
      });
      return;
    }

    // Generate the GitHub edit URL for the selected file
    const selectedFileName = selectedFilePath.split('/').pop() || selectedFilePath;
    const editUrl = `https://github.com/${owner}/${repo}/edit/${branch}/${selectedFilePath}`;

    // Update the modal to show success message
    if (body.view?.id) {
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          title: {
            type: 'plain_text',
            text: t('docUpdate.actions.editLink.title'),
          },
          close: {
            type: 'plain_text',
            text: t('common.button.close'),
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('docUpdate.actions.editLink.sent'),
              },
            },
          ],
        },
      });
    }

    // Send the edit link as a real DM. (postEphemeral needs a channel the user is
    // in — a bare user id is not one, so the link never arrived even though the
    // modal said it was "sent via Direct Messages". postMessage to a user id opens
    // the IM and delivers a persistent message.)
    await client.chat.postMessage({
      channel: body.user.id,
      text: t('docUpdate.actions.editLink.dm.fallback', { fileName: selectedFileName }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('docUpdate.actions.editLink.dm.body', {
              fileName: selectedFileName,
              editLink: `<${editUrl}|${t('docUpdate.actions.editLink.label.open')}>`,
            }),
          },
        },
      ],
    });

    logger.info(`Provided GitHub edit link for file: ${selectedFilePath} to user: ${body.user.id}`);

    // 로그: 성공
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'modal',
        'dm',
        'get_edit_link_for_selected_file',
        Date.now() - startTime,
        true,
        {
          modalSessionId,
          selectedFile: selectedFileName,
          selectedFilePath,
          editUrl,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log get edit link success:', logError);
    }
  } catch (error) {
    logger.error('Error providing GitHub edit link:', error);

    await client.chat.postEphemeral({
      channel: body.user.id,
      user: body.user.id,
      text: t('docUpdate.actions.editLink.error', {
        reason: describeError(t, error),
      }),
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'modal',
        'dm',
        'get_edit_link_for_selected_file',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          modalSessionId: body.actions?.[0]?.value,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log get edit link error:', logError);
    }
  }
};
