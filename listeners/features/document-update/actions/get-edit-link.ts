import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';

export const getEditLinkAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

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
        text: '⚠️ Please select a file from the dropdown first.',
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
            text: 'Edit Link Sent',
          },
          close: {
            type: 'plain_text',
            text: 'Close',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'The GitHub edit link has been sent to you via Direct Messages.',
              },
            },
          ],
        },
      });
    }

    // Send the edit link via ephemeral message
    await client.chat.postEphemeral({
      channel: body.user.id,
      user: body.user.id,
      text: `🔗 *GitHub Edit Link for ${selectedFileName}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔗 *GitHub Edit Link*\n\n📁 *File:* ${selectedFileName}\n🌐 *Link:* <${editUrl}|Open in GitHub>\n\n💡 *Tip:* Click the link above to edit the file directly in GitHub.`,
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
      text: `❌ Failed to generate edit link: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
