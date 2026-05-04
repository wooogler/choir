import type { App } from '@slack/bolt';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { GitHubOAuthDeviceFlow } from 'services/github/oauth-device-flow';
import { getRepositoryAccessError, normalizeRepositoryPath } from 'services/github/repository-access';
import { getWorkspaceId, parseGithubUrl, storeGithubRepo } from 'services/slack';
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
  app.action('browse_github_repositories', async ({ ack, body, client, logger }) => {
    await ack();

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
          text: '❌ Please connect your GitHub account first.',
        });
        return;
      }

      const accessToken = userGithubInfo.accessToken;

      const loadingViewResponse = await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRepositoryLoadingView(modalMetadata),
      });
      repositoryBrowseViewId = (loadingViewResponse as any).view?.id;

      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();
      const repositories = await githubOAuth.getRepositoriesWithMarkdown(accessToken);

      const repoOptions = repositories.slice(0, 10).map((repo) => ({
        text: {
          type: 'plain_text' as const,
          text: formatRepositoryOptionText(repo),
        },
        description: repo.markdownStats
          ? {
              type: 'plain_text' as const,
              text: `${repo.markdownStats.markdownFiles} markdown files · ${(repo.markdownStats.markdownRatio * 100).toFixed(1)}% of ${repo.markdownStats.totalFiles} files`,
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
            view: buildRepositoryEmptyView(modalMetadata),
          });
        } else {
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: '❌ No public writable repositories with markdown files were found.',
          });
        }
        return;
      }

      if (repositoryBrowseViewId) {
        await client.views.update({
          view_id: repositoryBrowseViewId,
          view: buildRepositorySelectionView(modalMetadata, repoOptions),
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
                text: 'Select Repository',
              },
              close: {
                type: 'plain_text',
                text: 'Close',
              },
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: '❌ Error loading repositories. Please try again.',
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
            text: '❌ Error loading repositories. Please try again.',
          });
        }
      } else {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error loading repositories. Please try again.',
        });
      }
    }
  });

  app.view('select_repository_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();
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
      if (!selectedRepo && !repositoryUrl) {
        await acknowledge({
          response_action: 'errors',
          errors: {
            repository_select_block: 'Choose a repository or paste a GitHub repository URL.',
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
            repository_url_block: 'Use either the repository picker or a URL, not both.',
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
              repository_select_block: 'Private repositories are not supported. Please choose a public repository.',
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
              repository_url_block: 'Enter a valid GitHub repository URL.',
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
          text: '❌ Please connect your GitHub account first.',
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
          text: `❌ ${accessError}`,
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
        text: '🔗 Connecting to repository and loading documents...',
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
          text: '⚠️ Repository connected but no markdown files found.',
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
            text: `✅ Successfully connected to ${repoInfo.owner}/${repoInfo.repo} and loaded ${markdownFiles.length} files!`,
          });

          // Log successful connection
          const { logAppHomeModalSubmit } = await import('services/common/interaction-tracker');
          await logAppHomeModalSubmit(
            userId,
            workspaceId,
            'select_repository_modal',
            Date.now() - startTime,
            true,
            `Successfully connected repository - ${repoInfo.owner}/${repoInfo.repo} at path: "${repositoryPath}" with ${markdownFiles.length} files`,
            {
              selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
              repositoryUrl: repoInfo.url,
              repositoryPath,
              branch,
              isPrivate: repository.private,
              filesFound: markdownFiles.length,
              vectorStoreInitialized: true,
              fileNames: markdownFiles.map((file) => file.name),
            },
            client,
          );
        } else {
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: '⚠️ Repository connected but failed to load documents. Please try refreshing.',
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
            repository_select_block: 'Error connecting the repository. Please try again.',
          },
        });
        return;
      }

      await client.chat.postEphemeral({
        user: userId || body.user.id,
        channel: userId || body.user.id,
        text: '❌ Error connecting the repository. Please try again.',
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
