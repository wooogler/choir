import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import { getRetrievalProvider } from 'services/retrieval';
import { QmdRetrievalProvider } from 'services/retrieval/qmd-provider';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { appHomeOpenedCallback } from '../../../event-handlers/app-home-handler';

export const rebuildQmdIndexAction = async ({
  ack,
  client,
  body,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<any>) => {
  const startTime = Date.now();
  await ack();

  try {
    const workspaceId = await getWorkspaceId(client);
    const isOwner = await isWorkspaceOwner(body.user.id, client);
    const isUserManager = await isManager(workspaceId, body.user.id);

    if (!isUserManager && !isOwner) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ You don't have permission to rebuild the QMD index.",
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "❌ You don't have permission to rebuild the QMD index.",
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION),
          },
        ],
      });

      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'rebuild_qmd_index',
        Date.now() - startTime,
        false,
        'Rebuild QMD Index',
        {
          error: 'Permission denied',
          isOwner,
          isUserManager,
        },
        client,
      );
      return;
    }

    const repoInfo = await getGithubRepo(workspaceId);
    if (!repoInfo) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No GitHub repository connected. Please connect a repository first.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No GitHub repository connected. Please connect a repository first.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    const mirrorService = WorkspaceMirrorService.getInstance();
    const syncState = await mirrorService.getSyncState(workspaceId);
    if (!syncState) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No synced markdown mirror found yet. Run Reload from GitHub first.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No synced markdown mirror found yet. Run Reload from GitHub first.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: '♻️ Rebuilding QMD index from the local markdown mirror...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '♻️ *Rebuilding QMD index from the local markdown mirror...*\n\nThis may take a minute or two when QMD runs embeddings on CPU. I’ll send a success or error message when it finishes.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    const retrievalProvider = getRetrievalProvider();
    if (!(retrievalProvider instanceof QmdRetrievalProvider)) {
      throw new Error('Configured retrieval provider is not a QmdRetrievalProvider.');
    }

    await QmdUpdateAnchorService.getInstance().invalidateWorkspace(workspaceId);
    logger.info(
      'QMD rebuild started. If QMD reports CPU mode, the process may appear idle while embeddings are generated.',
      { workspaceId },
    );
    const rebuildResult = await retrievalProvider.rebuildWorkspaceIndex(workspaceId);

    const embeddedChunks = rebuildResult.embedResult?.chunksEmbedded ?? 0;
    const processedDocs = rebuildResult.embedResult?.docsProcessed ?? 0;

    await client.chat.postMessage({
      channel: body.user.id,
      text: `✅ QMD index rebuilt successfully. Indexed ${rebuildResult.updateResult.indexed} files and embedded ${embeddedChunks} chunks.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *QMD index rebuilt successfully*\n*Indexed:* ${rebuildResult.updateResult.indexed}\n*Updated:* ${rebuildResult.updateResult.updated}\n*Unchanged:* ${rebuildResult.updateResult.unchanged}\n*Removed:* ${rebuildResult.updateResult.removed}\n*Docs embedded:* ${processedDocs}\n*Chunks embedded:* ${embeddedChunks}`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
        },
      ],
    });

    setTimeout(async () => {
      try {
        const mockEvent = {
          type: 'app_home_opened' as const,
          user: body.user.id,
          tab: 'home' as const,
          event_ts: Date.now().toString(),
        };

        const handlerArgs = {
          client,
          event: mockEvent,
          logger,
          context: {},
          payload: mockEvent,
        };

        await appHomeOpenedCallback(handlerArgs as any);
        logger.info(`Home screen refreshed for user ${body.user.id} after QMD rebuild`);
      } catch (error) {
        logger.error('Error refreshing home view after QMD rebuild:', error);
      }
    }, 3000);

    await logAppHomeButtonClick(
      body.user.id,
      workspaceId,
      'rebuild_qmd_index',
      Date.now() - startTime,
      true,
      'Rebuild QMD Index',
      {
        repoOwner: repoInfo.owner,
        repoName: repoInfo.repo,
        repoPath: repoInfo.path || '',
        indexed: rebuildResult.updateResult.indexed,
        updated: rebuildResult.updateResult.updated,
        unchanged: rebuildResult.updateResult.unchanged,
        removed: rebuildResult.updateResult.removed,
        docsEmbedded: processedDocs,
        chunksEmbedded: embeddedChunks,
      },
      client,
    );
  } catch (error) {
    logger.error('Error rebuilding QMD index:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Error occurred while rebuilding the QMD index.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❌ Error occurred while rebuilding the QMD index.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });

    try {
      const workspaceId = await getWorkspaceId(client);
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'rebuild_qmd_index',
        Date.now() - startTime,
        false,
        'Rebuild QMD Index',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log rebuild_qmd_index error:', logError);
    }
  }
};
