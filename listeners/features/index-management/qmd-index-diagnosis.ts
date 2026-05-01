import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { getWorkspaceId } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

export const diagnoseVectorStoreAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const userId = body.user.id;

    await client.chat.postMessage({
      channel: userId,
      text: 'Performing retrieval system diagnosis...',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Performing retrieval system diagnosis...' },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    const { VectorStoreService } = await import('services/file-registry/main-service');
    const workspaceId = await getWorkspaceId(client);
    const vectorStore = VectorStoreService.getInstance();
    const diagnosis = vectorStore.diagnoseVectorStore(workspaceId);
    const fileCount = diagnosis.details.documentCount;

    await client.chat.postMessage({
      channel: userId,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Retrieval System Status', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Status:* ${diagnosis.status}\n*Provider:* ${diagnosis.details.provider}\n*Loaded files:* ${fileCount}`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.HEALTH_CHECK),
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Rebuild Index', emoji: true },
              style: 'primary',
              action_id: 'rebuild_qmd_index',
              confirm: {
                title: { type: 'plain_text', text: 'Rebuild QMD Index?' },
                text: {
                  type: 'plain_text',
                  text: 'This will rebuild the local QMD SQLite index from the synced markdown mirror.',
                },
                confirm: { type: 'plain_text', text: 'Rebuild' },
                deny: { type: 'plain_text', text: 'Cancel' },
              },
            },
          ],
        },
      ],
      text: 'Retrieval system diagnosis results.',
    });
  } catch (error) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `An error occurred during diagnosis: ${error}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `An error occurred during diagnosis: ${error}` },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });
  }
};
