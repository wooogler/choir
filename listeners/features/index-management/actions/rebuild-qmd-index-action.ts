import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import { tForRequest } from 'services/i18n';
import { getRetrievalProvider } from 'services/retrieval';
import { QmdRetrievalProvider } from 'services/retrieval/qmd-provider';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { refreshAppHomeSoon } from '../../app-home/refresh';

export const rebuildQmdIndexAction = async ({
  ack,
  client,
  body,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<any>) => {
  const startTime = Date.now();
  await ack();

  // A rebuild announces itself, then reports minutes later in the same DM; one
  // translator covers both so the two halves cannot end up in two languages.
  const t = tForRequest(context);

  try {
    const workspaceId = await getWorkspaceId(client);
    const isOwner = await isWorkspaceOwner(body.user.id, client);
    const isUserManager = await isManager(workspaceId, body.user.id);

    if (!isUserManager && !isOwner) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('indexManagement.rebuild.error.permission'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.rebuild.error.permission'),
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
        text: t('indexManagement.shared.error.noRepo'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.shared.error.noRepo'),
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
        text: t('indexManagement.rebuild.error.noMirror'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.rebuild.error.noMirror'),
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: t('indexManagement.rebuild.progress.fallback'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.rebuild.progress.start'),
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
      text: t('indexManagement.rebuild.success.fallback', {
        indexed: t('common.count.files', { count: rebuildResult.updateResult.indexed }),
        chunks: t('indexManagement.rebuild.count.chunks', { count: embeddedChunks }),
      }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.rebuild.success', {
              indexed: rebuildResult.updateResult.indexed,
              updated: rebuildResult.updateResult.updated,
              unchanged: rebuildResult.updateResult.unchanged,
              removed: rebuildResult.updateResult.removed,
              docs: processedDocs,
              chunks: embeddedChunks,
            }),
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
        },
      ],
    });

    refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'QMD rebuild' }, 3000);

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
      text: t('indexManagement.rebuild.error.generic'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.rebuild.error.generic'),
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
