import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { parseMarkdownToTree } from 'services/document';
import { treeToMarkdown } from 'services/document/markdown';
import { GithubService } from 'services/github';
import { getGithubRepo, getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
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

    // GitHub에서 최신 마크다운 파일들 가져오기
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: repoInfo.path || '',
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

    // 벡터 저장소 업데이트 (캐시 사용 안 함, 강제 새로고침)
    const success = await vectorStore.initialize(markdownFiles, false, true);

    if (success) {
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
  }
};

export const normalizeMarkdownFilesAction = async ({
  ack,
  client,
  body,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<any>) => {
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

    // 모든 마크다운 파일 가져오기
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      path: repoInfo.path || '',
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
        const rebuildSuccess = await vectorStore.resetAndRebuildVectorStore();
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
