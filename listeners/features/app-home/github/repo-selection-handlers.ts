import type { App } from '@slack/bolt';
import { QmdUpdateAnchorService } from 'services/document/qmd-update-anchor-service';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { GitHubOAuthDeviceFlow } from 'services/github/oauth-device-flow';
import { getRepositoryAccessError, normalizeRepositoryPath } from 'services/github/repository-access';
import { tForRequest } from 'services/i18n';
import { getRetrievalProvider } from 'services/retrieval';
import { QmdRetrievalProvider } from 'services/retrieval/qmd-provider';
import { getWorkspaceId, isManager, isWorkspaceOwner, parseGithubUrl, storeGithubRepo } from 'services/slack';
import { GitHubSyncService } from 'services/sync/github-sync-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import {
  buildRepositoryEmptyView,
  buildRepositoryLoadingView,
  buildRepositorySelectionView,
  formatRepositoryOptionText,
} from './repository-selection-views';
import { refreshAppHome } from './shared';

export const registerRepositorySelectionHandlers = (app: App) => {
  app.action('browse_github_repositories', async ({ ack, body, client, context, logger }) => {
    await ack();

    // Browsing repositories replaces the same modal two or three times as the
    // listing loads, so one translator is bound up front and reused for every
    // one of those updates.
    const t = tForRequest(context);

    let repositoryBrowseViewId: string | undefined;

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;
      const modalMetadata = { userId, workspaceId };

      const workspaceStore = new WorkspaceStore();
      const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);

      if (!userGithubInfo) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.github.repoPicker.notConnected'),
        });
        return;
      }

      const accessToken = userGithubInfo.accessToken;

      const loadingViewResponse = await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRepositoryLoadingView(t, modalMetadata),
      });
      repositoryBrowseViewId = (loadingViewResponse as any).view?.id;

      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();
      const repositories = await githubOAuth.getRepositoriesWithMarkdown(accessToken);

      const repoOptions = repositories.slice(0, 10).map((repo) => ({
        text: {
          type: 'plain_text' as const,
          text: formatRepositoryOptionText(t, repo),
        },
        description: repo.markdownStats
          ? {
              type: 'plain_text' as const,
              text: t('appHome.github.repoPicker.option.description', {
                count: repo.markdownStats.markdownFiles,
                percent: (repo.markdownStats.markdownRatio * 100).toFixed(1),
                total: repo.markdownStats.totalFiles,
              }),
            }
          : undefined,
        value: JSON.stringify({
          owner: repo.owner.login,
          repo: repo.name,
          url: repo.html_url,
          private: repo.private,
          branch: repo.default_branch,
        }),
      }));

      if (repoOptions.length === 0) {
        if (repositoryBrowseViewId) {
          await client.views.update({
            view_id: repositoryBrowseViewId,
            view: buildRepositoryEmptyView(t, modalMetadata),
          });
        } else {
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: t('appHome.github.repoPicker.empty'),
          });
        }
        return;
      }

      if (repositoryBrowseViewId) {
        await client.views.update({
          view_id: repositoryBrowseViewId,
          view: buildRepositorySelectionView(t, modalMetadata, repoOptions),
        });
      }
    } catch (error) {
      logger.error('Error browsing GitHub repositories:', error);
      if (repositoryBrowseViewId) {
        try {
          const workspaceId = await getWorkspaceId(client);
          await client.views.update({
            view_id: repositoryBrowseViewId,
            view: {
              type: 'modal',
              callback_id: 'select_repository_error_modal',
              notify_on_close: true,
              title: {
                type: 'plain_text',
                text: t('appHome.github.repoPicker.title'),
              },
              close: {
                type: 'plain_text',
                text: t('common.button.close'),
              },
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: t('appHome.github.repoPicker.error'),
                  },
                },
              ],
              private_metadata: JSON.stringify({
                userId: body.user.id,
                workspaceId,
              }),
            },
          });
        } catch (updateError) {
          logger.error('Error updating repository browse modal after failure:', updateError);
          await client.chat.postEphemeral({
            user: body.user.id,
            channel: body.user.id,
            text: t('appHome.github.repoPicker.error'),
          });
        }
      } else {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.github.repoPicker.error'),
        });
      }
    }
  });

  app.view('select_repository_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    // Connecting a repository narrates itself across several minutes of cloning
    // and indexing; the submitter is the only reader, so their locale is bound
    // once and every later message uses it.
    const t = tForRequest(context);
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { userId, workspaceId } = metadata;
    const selectedRepo = view.state.values.repository_select_block.repository_select.selected_option?.value;
    const repositoryUrl = view.state.values.repository_url_block?.repository_url?.value?.trim() || '';
    const pathInput = normalizeRepositoryPath(view.state.values.path_input_block.path_input.value || '');
    let didAck = false;
    const acknowledge = async (response?: any) => {
      didAck = true;
      if (response === undefined) {
        await ack();
      } else {
        await ack(response);
      }
    };

    try {
      // Connecting a repository is a manager/owner-only action (server-side check;
      // hiding the button in the home view is not enforcement).
      const [connectorIsManager, connectorIsOwner] = await Promise.all([
        isManager(workspaceId, userId),
        isWorkspaceOwner(userId, client),
      ]);
      if (!connectorIsManager && !connectorIsOwner) {
        await acknowledge();
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.github.connectRepo.error.permission'),
        });
        return;
      }

      if (!selectedRepo && !repositoryUrl) {
        await acknowledge({
          response_action: 'errors',
          errors: {
            repository_select_block: t('appHome.github.connectRepo.error.noSelection'),
          },
        });

        const { logAppHomeModalSubmit } = await import('services/common/interaction-tracker');
        await logAppHomeModalSubmit(
          userId,
          workspaceId,
          'select_repository_modal',
          Date.now() - startTime,
          false,
          'Repository selection modal submitted without selecting a repository or URL',
          {
            error: 'No repository selected',
            enteredPath: pathInput,
          },
          client,
        );
        return;
      }

      if (selectedRepo && repositoryUrl) {
        await acknowledge({
          response_action: 'errors',
          errors: {
            repository_url_block: t('appHome.github.connectRepo.error.bothInputs'),
          },
        });
        return;
      }

      let repoInfo: {
        owner: string;
        repo: string;
        url: string;
        private?: boolean;
        branch?: string;
        path?: string;
      };

      if (selectedRepo) {
        repoInfo = JSON.parse(selectedRepo);
        if (repoInfo.private) {
          await acknowledge({
            response_action: 'errors',
            errors: {
              repository_select_block: t('appHome.github.connectRepo.error.privateRepo'),
            },
          });
          return;
        }
      } else {
        const parsedRepo = parseGithubUrl(repositoryUrl);
        if (!parsedRepo) {
          await acknowledge({
            response_action: 'errors',
            errors: {
              repository_url_block: t('appHome.github.connectRepo.error.invalidUrl'),
            },
          });
          return;
        }

        repoInfo = {
          owner: parsedRepo.owner,
          repo: parsedRepo.repo,
          url: `https://github.com/${parsedRepo.owner}/${parsedRepo.repo}`,
          branch: parsedRepo.branch,
          path: parsedRepo.path,
        };
      }

      await acknowledge();

      const workspaceStore = new WorkspaceStore();
      const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);
      if (!userGithubInfo) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.github.repoPicker.notConnected'),
        });
        return;
      }

      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();
      const repository = await githubOAuth.getRepository(userGithubInfo.accessToken, repoInfo.owner, repoInfo.repo);
      const accessError = getRepositoryAccessError(repository);
      if (accessError) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          // `accessError` is written by `services/github/repository-access`, which
          // has no translator of its own, so it rides along as an opaque reason.
          text: t('appHome.github.connectRepo.error.access', { reason: accessError }),
        });
        return;
      }

      const branch = repoInfo.branch || repository.default_branch;
      const repositoryPath = pathInput || normalizeRepositoryPath(repoInfo.path);

      await storeGithubRepo(workspaceId, {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        url: repository.html_url || repoInfo.url,
        path: repositoryPath,
        branch,
      });

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.github.connectRepo.progress.connecting'),
      });

      const githubService = GithubService.getInstance();
      const vectorStore = VectorStoreService.getInstance();
      const gitHubSyncService = GitHubSyncService.getInstance();

      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        path: repositoryPath,
        ref: branch,
        workspaceId: workspaceId,
        userId: userId,
      });

      if (markdownFiles.length === 0) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.github.connectRepo.noFiles'),
        });

        // Log no files found
        const { logAppHomeModalSubmit } = await import('services/common/interaction-tracker');
        await logAppHomeModalSubmit(
          userId,
          workspaceId,
          'select_repository_modal',
          Date.now() - startTime,
          true,
          `Repository connected but no markdown files found - ${repoInfo.owner}/${repoInfo.repo} at path: "${repositoryPath}"`,
          {
            selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
            repositoryUrl: repoInfo.url,
            repositoryPath,
            branch,
            isPrivate: repository.private,
            filesFound: 0,
            vectorStoreInitialized: false,
          },
          client,
        );
      } else {
        await gitHubSyncService.syncWorkspaceFromMarkdownFiles({
          workspaceId,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          branch,
          markdownFiles,
          source: 'manual-refresh',
        });

        const success = await vectorStore.initialize(markdownFiles, false, true, workspaceId);

        if (success) {
          // Update workspace markdown files cache
          const workspaceStore = new WorkspaceStore();
          const fileList = markdownFiles.map((file) => ({
            name: file.name,
            path: file.path,
          }));
          await workspaceStore.setMarkdownFilesCache(workspaceId, fileList);

          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: t('appHome.github.connectRepo.progress.loaded', {
              count: markdownFiles.length,
              repository: `${repoInfo.owner}/${repoInfo.repo}`,
            }),
          });

          let qmdIndexReady = false;
          let qmdMetadata: Record<string, unknown> = { qmdIndexReady: false };
          try {
            const retrievalProvider = getRetrievalProvider();
            if (!(retrievalProvider instanceof QmdRetrievalProvider)) {
              throw new Error('Configured retrieval provider is not a QmdRetrievalProvider.');
            }

            await QmdUpdateAnchorService.getInstance().invalidateWorkspace(workspaceId);
            logger.info('Building QMD index after repository connection', {
              workspaceId,
              repository: `${repoInfo.owner}/${repoInfo.repo}`,
              filesFound: markdownFiles.length,
            });
            const rebuildResult = await retrievalProvider.rebuildWorkspaceIndex(workspaceId);
            const embeddedChunks = rebuildResult.embedResult?.chunksEmbedded ?? 0;
            const processedDocs = rebuildResult.embedResult?.docsProcessed ?? 0;

            qmdIndexReady = true;
            qmdMetadata = {
              qmdIndexReady: true,
              qmdIndexed: rebuildResult.updateResult.indexed,
              qmdUpdated: rebuildResult.updateResult.updated,
              qmdUnchanged: rebuildResult.updateResult.unchanged,
              qmdRemoved: rebuildResult.updateResult.removed,
              qmdDocsEmbedded: processedDocs,
              qmdChunksEmbedded: embeddedChunks,
            };

            await client.chat.postEphemeral({
              user: userId,
              channel: userId,
              text: t('appHome.github.connectRepo.success', {
                count: markdownFiles.length,
                repository: `${repoInfo.owner}/${repoInfo.repo}`,
              }),
            });
          } catch (qmdError) {
            logger.error('Repository connected but QMD index build failed:', qmdError);
            qmdMetadata = {
              qmdIndexReady: false,
              qmdIndexError: qmdError instanceof Error ? qmdError.message : 'Unknown QMD index error',
              qmdIndexErrorStack: qmdError instanceof Error ? qmdError.stack : undefined,
            };

            await client.chat.postEphemeral({
              user: userId,
              channel: userId,
              text: t('appHome.github.connectRepo.indexFailed', { count: markdownFiles.length }),
            });
          }

          // Log successful connection
          const { logAppHomeModalSubmit } = await import('services/common/interaction-tracker');
          await logAppHomeModalSubmit(
            userId,
            workspaceId,
            'select_repository_modal',
            Date.now() - startTime,
            qmdIndexReady,
            qmdIndexReady
              ? `Successfully connected repository and built QMD index - ${repoInfo.owner}/${repoInfo.repo} at path: "${repositoryPath}" with ${markdownFiles.length} files`
              : `Repository connected but QMD index build failed - ${repoInfo.owner}/${repoInfo.repo} at path: "${repositoryPath}" with ${markdownFiles.length} files`,
            {
              selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
              repositoryUrl: repoInfo.url,
              repositoryPath,
              branch,
              isPrivate: repository.private,
              filesFound: markdownFiles.length,
              vectorStoreInitialized: true,
              ...qmdMetadata,
              fileNames: markdownFiles.map((file) => file.name),
            },
            client,
          );
        } else {
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: t('appHome.github.connectRepo.loadFailed'),
          });

          // Log vector store failure
          const { logAppHomeModalSubmit } = await import('services/common/interaction-tracker');
          await logAppHomeModalSubmit(
            userId,
            workspaceId,
            'select_repository_modal',
            Date.now() - startTime,
            false,
            `Repository connected but vector store initialization failed - ${repoInfo.owner}/${repoInfo.repo} at path: "${repositoryPath}" with ${markdownFiles.length} files`,
            {
              selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
              repositoryUrl: repoInfo.url,
              repositoryPath,
              branch,
              isPrivate: repository.private,
              filesFound: markdownFiles.length,
              vectorStoreInitialized: false,
              error: 'Vector store initialization failed',
            },
            client,
          );
        }
      }

      setTimeout(async () => {
        try {
          await refreshAppHome({ client, logger, userId, reason: 'repository connection' });
          logger.info(`Home screen refreshed for user ${userId} after repository connection`);
        } catch (error) {
          logger.error('Error refreshing home view after repository connection:', error);
        }
      }, 1000);
    } catch (error) {
      logger.error('Error processing repository selection:', error);
      if (!didAck) {
        await acknowledge({
          response_action: 'errors',
          errors: {
            repository_select_block: t('appHome.github.connectRepo.error.inline'),
          },
        });
        return;
      }

      await client.chat.postEphemeral({
        user: userId || body.user.id,
        channel: userId || body.user.id,
        text: t('appHome.github.connectRepo.error.generic'),
      });

      // Log error
      try {
        const { logAppHomeModalSubmit } = await import('services/common/interaction-tracker');
        await logAppHomeModalSubmit(
          userId,
          workspaceId,
          'select_repository_modal',
          Date.now() - startTime,
          false,
          'Repository selection modal error',
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
  });
};
