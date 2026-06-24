import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';

/**
 * Inline file switcher on a suggestion (item I). Changing the dropdown retargets
 * the review to the chosen file by re-running the file-based review flow.
 * The review sessionId is carried in the select's block_id (`file_switcher::<sessionId>`);
 * the chosen file path is the selected option value.
 */
export const switchFileForReviewAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs) => {
  const startTime = Date.now();
  await ack();

  try {
    const action = (body as any).actions?.[0];
    const selectedFile = action?.selected_option?.value;
    const blockId: string = action?.block_id || '';
    const sessionId = blockId.split('::')[1];

    if (!selectedFile || !sessionId) {
      logger.warn(`switch_file_for_review: missing selectedFile or sessionId (blockId="${blockId}")`);
      return;
    }

    logger.info(`User ${(body as any).user?.id} switched review to file: ${selectedFile}`);

    const { suggestUpdatesCallback } = await import('../suggestions/suggest-updates-handler');
    const modifiedBody = {
      ...body,
      actions: [
        {
          value: JSON.stringify({
            index: 0,
            sessionId,
            selectedFile,
            isFileBasedReview: true,
            isDefaultFile: false,
          }),
        },
      ],
    };

    await suggestUpdatesCallback({
      ack: async () => {}, // Already acked
      body: modifiedBody,
      client,
      logger,
    } as any);

    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      (body as any).user.id,
      workspaceId,
      (body as any).channel?.id || 'dm',
      'dm',
      'switch_file_for_review',
      Date.now() - startTime,
      true,
      { sessionId, selectedFile },
      client,
    );
  } catch (error) {
    logger.error('Error switching file for review:', error);
  }
};
