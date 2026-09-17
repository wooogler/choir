import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { parseMarkdownToTree } from 'services/document';
import { treeToMarkdown } from 'services/document/markdown';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { tForRequest } from 'services/i18n';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { refreshAppHomeSoon } from '../../app-home/refresh';

export const normalizeMarkdownFilesAction = async ({
  ack,
  client,
  body,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<any>) => {
  const startTime = Date.now();
  await ack();

  // Normalization rewrites every file in the repository and reports four times
  // along the way, all to the clicker; the translator is bound once up front.
  const t = tForRequest(context);

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
        text: t('indexManagement.normalize.error.permission'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.normalize.error.permission'),
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION),
          },
        ],
      });
      return;
    }

    await client.chat.postMessage({
      channel: body.user.id,
      text: t('indexManagement.normalize.progress.start'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.normalize.progress.start'),
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

      const extractedRepoInfo = vectorStore.extractRepoInfoFromFiles(workspaceId);

      if (extractedRepoInfo) {
        repoInfo = extractedRepoInfo;
        logger.info('Extracted repository info from vector store:', repoInfo);
      }
    }

    if (!repoInfo) {
      logger.warn('No GitHub repository connected and cannot extract from vector store');
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('indexManagement.normalize.error.noRepo'),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.normalize.error.noRepo'),
            },
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          },
        ],
      });
      return;
    }

    // Respect a deliberately configured branch; only resolve the repo default when
    // none is set. getDefaultBranch falls back to 'main' on error, so running it
    // unconditionally could overwrite the configured branch on a transient failure.
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

    // 모든 마크다운 파일 가져오기 (설정된 브랜치 사용)
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

    await client.chat.postMessage({
      channel: body.user.id,
      text: t('indexManagement.normalize.progress.found', { count: markdownFiles.length }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.normalize.progress.found', { count: markdownFiles.length }),
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
            branch: branchToUse,
            workspaceId: workspaceId,
            userId: body.user.id,
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
        text: t('indexManagement.normalize.success', { count: successCount }),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.normalize.success', { count: successCount }),
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
            text: t('indexManagement.normalize.rebuilt'),
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: t('indexManagement.normalize.rebuilt'),
                },
                block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
              },
            ],
          });

          refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'markdown normalization' });

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
            text: t('indexManagement.normalize.rebuildFailed'),
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: t('indexManagement.normalize.rebuildFailed'),
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
          text: t('indexManagement.normalize.rebuildFailed'),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('indexManagement.normalize.rebuildFailed'),
              },
              block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            },
          ],
        });
      }
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: t('indexManagement.normalize.partial', {
          normalized: t('indexManagement.normalize.count.normalized', { count: successCount }),
          failed: t('indexManagement.normalize.count.failed', { count: failCount }),
        }),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('indexManagement.normalize.partial', {
                normalized: t('indexManagement.normalize.count.normalized', { count: successCount }),
                failed: t('indexManagement.normalize.count.failed', { count: failCount }),
              }),
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
      text: t('indexManagement.normalize.error.generic'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('indexManagement.normalize.error.generic'),
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });
  }

  logger.info('Normalize markdown files action completed');
};
