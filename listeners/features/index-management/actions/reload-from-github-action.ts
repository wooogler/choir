import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { appHomeOpenedCallback } from '../../../event-handlers/app-home-handler';

/**
 * Reload files from GitHub and update vector store.
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
      const extractedRepoInfo = vectorStore.extractRepoInfoFromFiles(workspaceId);
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
