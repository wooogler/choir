import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/user-interaction-logger';
import { parseMarkdownToTree } from 'services/document';
import { treeToMarkdown } from 'services/document/markdown';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import { GithubService } from 'services/github';
import { getRetrievalProvider } from 'services/retrieval';
import { isQmdRetrievalEnabled } from 'services/retrieval/provider-config';
import { QmdRetrievalProvider } from 'services/retrieval/qmd-provider';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { appHomeOpenedCallback } from '../../../event-handlers/app-home-handler';

/**
 * Reload files from GitHub and update vector store
 */
export const reloadFromGithubAction = async ({
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
        text: "❌ You don't have permission to reload from GitHub.",
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "❌ You don't have permission to reload from GitHub.",
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION),
          },
        ],
      });

      // Log permission denied
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'reload_from_github',
        Date.now() - startTime,
        false,
        'Reload From GitHub',
        {
          error: 'Permission denied',
          isOwner,
          isUserManager,
        },
        client,
      );
      return;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: '🔄 Reloading files from GitHub...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🔄 Reloading files from GitHub...',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    const githubService = GithubService.getInstance();
    const vectorStore = VectorStoreService.getInstance();

    // GitHub 저장소 정보 가져오기
    let repoInfo = await getGithubRepo(workspaceId);

    // 저장소 정보가 없으면 VectorStoreService에서 현재 로드된 파일들로부터 추출
    if (!repoInfo) {
      const extractedRepoInfo = vectorStore.extractRepoInfoFromFiles();
      if (extractedRepoInfo) {
        repoInfo = extractedRepoInfo;
      }
    }

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

    // GitHub에서 현재 기본 브랜치 확인 및 업데이트
    const currentDefaultBranch = await githubService.getDefaultBranch(
      repoInfo.owner,
      repoInfo.repo,
      workspaceId,
      body.user.id,
    );

    // 기존 브랜치와 다르면 워크스페이스 설정 업데이트
    if (repoInfo.branch !== currentDefaultBranch) {
      const { storeGithubRepo } = await import('services/slack');
      await storeGithubRepo(workspaceId, {
        ...repoInfo,
        branch: currentDefaultBranch,
      });
      logger.info(`Updated repository branch from ${repoInfo.branch || 'undefined'} to ${currentDefaultBranch}`);
    }

    // GitHub에서 최신 마크다운 파일들 가져오기 (업데이트된 브랜치 사용)
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: repoInfo.path || '',
      ref: currentDefaultBranch,
      workspaceId: workspaceId,
      userId: body.user.id,
    });

    if (markdownFiles.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No markdown files found in the repository.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No markdown files found in the repository.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    const { GitHubSyncService } = await import('services/sync/github-sync-service');
    await GitHubSyncService.getInstance().syncWorkspaceFromMarkdownFiles({
      workspaceId,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: currentDefaultBranch,
      markdownFiles,
      source: 'manual-refresh',
    });

    // 벡터 저장소 업데이트 (캐시 사용 안 함, 강제 새로고침)
    const success = await vectorStore.initialize(markdownFiles, false, true, workspaceId);

    if (success) {
      // Update workspace markdown files cache
      const { WorkspaceStore } = await import('services/workspace/workspace-store');
      const workspaceStore = new WorkspaceStore();
      const fileList = markdownFiles.map((file) => ({
        name: file.name,
        path: file.path,
      }));
      await workspaceStore.setMarkdownFilesCache(workspaceId, fileList);
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Successfully reloaded ${markdownFiles.length} files from GitHub and updated vector store!`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ Successfully reloaded ${markdownFiles.length} files from GitHub and updated vector store!`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          },
        ],
      });

      // Auto-refresh home screen after a longer delay to avoid conflicts
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
          logger.info(`Home screen refreshed for user ${body.user.id} after GitHub reload`);
        } catch (error) {
          logger.error('Error refreshing home view after GitHub reload:', error);
        }
      }, 3000);

      // Log success
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'reload_from_github',
        Date.now() - startTime,
        true,
        'Reload From GitHub',
        {
          filesCount: markdownFiles.length,
          repoOwner: repoInfo.owner,
          repoName: repoInfo.repo,
          repoPath: repoInfo.path || '',
        },
        client,
      );
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Failed to update vector store with new files. Please check the logs.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ Failed to update vector store with new files. Please check the logs.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });

      // Log vector store failure
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'reload_from_github',
        Date.now() - startTime,
        false,
        'Reload From GitHub',
        {
          error: 'Failed to update vector store',
          filesCount: markdownFiles.length,
          repoOwner: repoInfo.owner,
          repoName: repoInfo.repo,
          repoPath: repoInfo.path || '',
        },
        client,
      );
    }
  } catch (error) {
    logger.error('Error reloading from GitHub:', error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Error occurred while reloading from GitHub.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❌ Error occurred while reloading from GitHub.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });

    // Log catch error
    try {
      const workspaceId = await getWorkspaceId(client);
      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'reload_from_github',
        Date.now() - startTime,
        false,
        'Reload From GitHub',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        client,
      );
    } catch (logError) {
      logger.error('Failed to log error:', logError);
    }
  }
};

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

    if (!isQmdRetrievalEnabled()) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ QMD retrieval is not enabled in this environment.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ QMD retrieval is not enabled in this environment.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
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
            text: '♻️ Rebuilding QMD index from the local markdown mirror...',
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
            text:
              `✅ *QMD index rebuilt successfully*\n` +
              `*Indexed:* ${rebuildResult.updateResult.indexed}\n` +
              `*Updated:* ${rebuildResult.updateResult.updated}\n` +
              `*Unchanged:* ${rebuildResult.updateResult.unchanged}\n` +
              `*Removed:* ${rebuildResult.updateResult.removed}\n` +
              `*Docs embedded:* ${processedDocs}\n` +
              `*Chunks embedded:* ${embeddedChunks}`,
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

export const normalizeMarkdownFilesAction = async ({
  ack,
  client,
  body,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<any>) => {
  const startTime = Date.now();
  await ack();

  logger.info('Normalize markdown files action triggered by user:', body.user.id);

  try {
    const workspaceId = await getWorkspaceId(client);
    const isOwner = await isWorkspaceOwner(body.user.id, client);
    const isUserManager = await isManager(workspaceId, body.user.id);

    logger.info(`Permission check - isOwner: ${isOwner}, isUserManager: ${isUserManager}`);

    if (!isUserManager && !isOwner) {
      logger.warn('User does not have permission to normalize markdown files');
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ You don't have permission to normalize markdown files.",
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "❌ You don't have permission to normalize markdown files.",
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION),
          },
        ],
      });
      return;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: '🔄 Starting markdown files normalization...\nThis may take a while depending on the number of files.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🔄 Starting markdown files normalization...\nThis may take a while depending on the number of files.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    const githubService = GithubService.getInstance();
    const vectorStore = VectorStoreService.getInstance();

    // GitHub 저장소 정보 가져오기
    let repoInfo = await getGithubRepo(workspaceId);
    logger.info('Repository info:', repoInfo);

    // 저장소 정보가 없으면 VectorStoreService에서 현재 로드된 파일들로부터 추출
    if (!repoInfo) {
      logger.info('No repository info found, trying to extract from vector store...');

      const extractedRepoInfo = vectorStore.extractRepoInfoFromFiles();

      if (extractedRepoInfo) {
        repoInfo = extractedRepoInfo;
        logger.info('Extracted repository info from vector store:', repoInfo);
      }
    }

    if (!repoInfo) {
      logger.warn('No GitHub repository connected and cannot extract from vector store');
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No GitHub repository connected. Please connect a repository first or ensure vector store has loaded files.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No GitHub repository connected. Please connect a repository first or ensure vector store has loaded files.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    // GitHub에서 현재 기본 브랜치 확인 및 업데이트
    const currentDefaultBranch = await githubService.getDefaultBranch(
      repoInfo.owner,
      repoInfo.repo,
      workspaceId,
      body.user.id,
    );

    // 기존 브랜치와 다르면 워크스페이스 설정 업데이트
    if (repoInfo.branch !== currentDefaultBranch) {
      const { storeGithubRepo } = await import('services/slack');
      await storeGithubRepo(workspaceId, {
        ...repoInfo,
        branch: currentDefaultBranch,
      });
      logger.info(`Updated repository branch from ${repoInfo.branch || 'undefined'} to ${currentDefaultBranch}`);
    }

    // 모든 마크다운 파일 가져오기 (업데이트된 브랜치 사용)
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: repoInfo.path || '',
      ref: currentDefaultBranch,
      workspaceId: workspaceId,
      userId: body.user.id,
    });

    if (markdownFiles.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ No markdown files found in the repository.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '❌ No markdown files found in the repository.',
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: `📄 Found ${markdownFiles.length} markdown files. Starting normalization...`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📄 Found ${markdownFiles.length} markdown files. Starting normalization...`,
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.STATUS_UPDATE),
        },
      ],
    });

    let successCount = 0;
    let failCount = 0;

    // 각 파일을 트리로 변환 후 다시 마크다운으로 변환하여 업데이트
    for (const file of markdownFiles) {
      try {
        logger.info(`Normalizing file: ${file.name}`);

        // 파일 내용을 트리로 파싱
        const tree = parseMarkdownToTree(file.content, file.name);

        // 트리를 다시 마크다운으로 변환
        const normalizedMarkdown = treeToMarkdown(tree);

        // 원본과 다른 경우에만 업데이트
        if (normalizedMarkdown !== file.content) {
          await githubService.updateMarkdownFile({
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            path: file.path,
            content: normalizedMarkdown,
            message: `Normalize markdown formatting for ${file.name}`,
          });

          logger.info(`Successfully normalized: ${file.name}`);
          successCount++;
        } else {
          logger.info(`No changes needed for: ${file.name}`);
          successCount++;
        }
      } catch (error) {
        logger.error(`Failed to normalize ${file.name}:`, error);
        failCount++;
      }
    }

    // 결과 알림
    if (failCount === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Successfully normalized ${successCount} markdown files!\n\n🔄 Rebuilding vector store to reflect changes...`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ Successfully normalized ${successCount} markdown files!\n\n🔄 Rebuilding vector store to reflect changes...`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          },
        ],
      });

      // 벡터 스토어 재구축
      try {
        const rebuildSuccess = await vectorStore.resetAndRebuildVectorStore(workspaceId);
        if (rebuildSuccess) {
          await client.chat.postMessage({
            channel: body.user.id,
            text: '✅ Vector store successfully rebuilt with normalized files!',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '✅ Vector store successfully rebuilt with normalized files!',
                },
                block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
              },
            ],
          });

          // Auto-refresh home screen
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
              logger.info(`Home screen refreshed for user ${body.user.id} after markdown normalization`);
            } catch (error) {
              logger.error('Error refreshing home view after markdown normalization:', error);
            }
          }, 1000);

          // Log successful normalization
          await logAppHomeButtonClick(
            body.user.id,
            workspaceId,
            'normalize_markdown_files',
            Date.now() - startTime,
            true,
            'Normalize Markdown Files',
            {
              successCount,
              totalFiles: markdownFiles.length,
              vectorStoreRebuilt: true,
            },
            client,
          );
        } else {
          await client.chat.postMessage({
            channel: body.user.id,
            text: '⚠️ Markdown normalization completed, but vector store rebuild failed. Please rebuild manually.',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '⚠️ Markdown normalization completed, but vector store rebuild failed. Please rebuild manually.',
                },
                block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
              },
            ],
          });
        }
      } catch (vectorError) {
        logger.error('Error rebuilding vector store after normalization:', vectorError);
        await client.chat.postMessage({
          channel: body.user.id,
          text: '⚠️ Markdown normalization completed, but vector store rebuild failed. Please rebuild manually.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '⚠️ Markdown normalization completed, but vector store rebuild failed. Please rebuild manually.',
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            },
          ],
        });
      }
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `⚠️ Normalization completed with issues:\n✅ ${successCount} files normalized\n❌ ${failCount} files failed\n\nPlease check the logs for details.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ Normalization completed with issues:\n✅ ${successCount} files normalized\n❌ ${failCount} files failed\n\nPlease check the logs for details.`,
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
    }
  } catch (error) {
    logger.error('Error normalizing markdown files:', error);
    logger.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    await client.chat.postMessage({
      channel: body.user.id,
      text: '❌ Error occurred while normalizing markdown files. Please check the logs.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❌ Error occurred while normalizing markdown files. Please check the logs.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });
  }

  logger.info('Normalize markdown files action completed');
};
