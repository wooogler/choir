import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { tForRequest } from 'services/i18n';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { refreshAppHomeSoon } from '../../app-home/refresh';

/**
 * Reload files from GitHub and update vector store.
 */
export const reloadFromGithubAction = async ({
  ack,
  client,
  body,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<any>) => {
  const startTime = Date.now();
  await ack();

  // The reload posts a progress message and then a result minutes later, both
  // into the clicker's DM, so the translator is resolved once and reused.
  const t = tForRequest(context);

  try {
    const workspaceId = await getWorkspaceId(client);
    const isOwner = await isWorkspaceOwner(body.user.id, client);
    const isUserManager = await isManager(workspaceId, body.user.id);

    if (!isUserManager && !isOwner) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('indexManagement.reload.error.permission'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.reload.error.permission'),
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
      text: t('indexManagement.reload.progress.start'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.reload.progress.start'),
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

    // Respect a deliberately configured branch. Only resolve the repo default when
    // no branch is set yet — getDefaultBranch silently falls back to 'main' on any
    // error, so letting it run unconditionally would overwrite the configured
    // branch (and reindex the wrong branch) on a transient GitHub failure.
    let branchToUse = repoInfo.branch;
    if (!branchToUse) {
      branchToUse = await githubService.getDefaultBranch(repoInfo.owner, repoInfo.repo, workspaceId, body.user.id);
      const { storeGithubRepo } = await import('services/slack');
      await storeGithubRepo(workspaceId, {
        ...repoInfo,
        branch: branchToUse,
      });
      logger.info(`No branch configured; set repository branch to default: ${branchToUse}`);
    }

    // GitHub에서 최신 마크다운 파일들 가져오기 (설정된 브랜치 사용)
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: repoInfo.path || '',
      ref: branchToUse,
      workspaceId: workspaceId,
      userId: body.user.id,
    });

    if (markdownFiles.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('indexManagement.shared.error.noMarkdownFiles'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.shared.error.noMarkdownFiles'),
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
      branch: branchToUse,
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
        text: t('indexManagement.reload.success', { count: markdownFiles.length }),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.reload.success', { count: markdownFiles.length }),
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          },
        ],
      });

      refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'GitHub reload' }, 3000);

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
        text: t('indexManagement.reload.error.vectorStore'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.reload.error.vectorStore'),
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
      text: t('indexManagement.reload.error.generic'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.reload.error.generic'),
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
