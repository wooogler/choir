import type { App } from '@slack/bolt';
import { GithubService } from 'services/github';
import { GitHubOAuthDeviceFlow } from 'services/github/oauth-device-flow';
import { GitHubSyncService } from 'services/sync/github-sync-service';
import { getWorkspaceId, storeGithubRepo } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

function formatRepositoryOptionText(repo: {
  full_name: string;
  markdownStats?: {
    markdownFiles: number;
  };
}): string {
  const markdownFiles = repo.markdownStats?.markdownFiles || 0;
  const suffix = markdownFiles > 0 ? ` (${markdownFiles} md)` : '';
  const text = `${repo.full_name}${suffix}`;

  return text.length > 75 ? `${text.slice(0, 72)}...` : text;
}

function buildRepositoryLoadingView(metadata: { userId: string; workspaceId: string }) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_loading_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: 'Select Repository',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '⏳ *Loading repositories*\n\nChecking which repositories you can write to and which ones already contain `.md` files...',
        },
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

function buildRepositorySelectionView(
  metadata: { userId: string; workspaceId: string },
  repoOptions: Array<{
    text: {
      type: 'plain_text';
      text: string;
    };
    description?:
      | {
          type: 'plain_text';
          text: string;
        }
      | undefined;
    value: string;
  }>,
) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: 'Select Repository',
    },
    submit: {
      type: 'plain_text' as const,
      text: 'Connect Repository',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '📂 *Select a GitHub repository to connect*\n\nOnly public repositories that you can write to and that already contain `.md` files are shown below.',
        },
      },
      {
        type: 'input' as const,
        block_id: 'repository_select_block',
        element: {
          type: 'static_select' as const,
          action_id: 'repository_select',
          placeholder: {
            type: 'plain_text' as const,
            text: 'Choose a repository...',
          },
          options: repoOptions,
        },
        label: {
          type: 'plain_text' as const,
          text: 'Repository',
        },
      },
      {
        type: 'input' as const,
        block_id: 'path_input_block',
        element: {
          type: 'plain_text_input' as const,
          action_id: 'path_input',
          placeholder: {
            type: 'plain_text' as const,
            text: 'docs/ (optional - leave empty for root)',
          },
        },
        label: {
          type: 'plain_text' as const,
          text: 'Path in Repository',
        },
        optional: true,
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

function buildRepositoryEmptyView(metadata: { userId: string; workspaceId: string }) {
  return {
    type: 'modal' as const,
    callback_id: 'select_repository_empty_modal',
    notify_on_close: true,
    title: {
      type: 'plain_text' as const,
      text: 'Select Repository',
    },
    close: {
      type: 'plain_text' as const,
      text: 'Close',
    },
    blocks: [
      {
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: '❌ No public writable repositories with markdown files were found.',
        },
      },
    ],
    private_metadata: JSON.stringify(metadata),
  };
}

export const registerGitHubHandlers = (app: App) => {
  app.action('connect_personal_github', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      const { GitHubOAuthDeviceFlow } = await import('services/github/oauth-device-flow');
      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();

      const deviceCode = await githubOAuth.requestDeviceCode();

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'github_device_code_modal',
          notify_on_close: true,
          title: {
            type: 'plain_text',
            text: 'Connect GitHub',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '🔐 *Connect your GitHub account*\n\nTo connect your GitHub account, please follow these steps:',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `1. Go to: *<${deviceCode.verification_uri}|${deviceCode.verification_uri}>*\n2. Enter this code: \`${deviceCode.user_code}\`\n3. Authorize CHOIR to access your GitHub account`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⏰ *Code expires in ${Math.floor(deviceCode.expires_in / 60)} minutes*`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '💡 This window will automatically close once you complete the authorization on GitHub.',
                },
              ],
            },
          ],
          private_metadata: JSON.stringify({
            deviceCode: deviceCode.device_code,
            userId,
            workspaceId,
          }),
        },
      });

      setTimeout(async () => {
        try {
          const tokenResponse = await githubOAuth.pollForAccessToken(deviceCode.device_code, deviceCode.interval);
          const user = await githubOAuth.getUserInfo(tokenResponse.access_token);

          const workspaceStore = new WorkspaceStore();
          await workspaceStore.setUserGithubToken(workspaceId, userId, {
            accessToken: tokenResponse.access_token,
            user,
          });

          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: `✅ GitHub account connected successfully! Welcome, ${user.name || user.login}!`,
          });

          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
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
          logger.info(`GitHub connected for user ${userId} in workspace ${workspaceId}`);
        } catch (error) {
          logger.error('Error during GitHub OAuth flow:', error);
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: '❌ GitHub connection failed. Please try again.',
          });
        }
      }, 2000);
    } catch (error) {
      logger.error('Error initiating GitHub connection:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error starting GitHub connection. Please try again.',
      });
    }
  });

  app.action('disconnect_personal_github', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      const workspaceStore = new WorkspaceStore();
      await workspaceStore.removeUserGithubToken(workspaceId, userId);

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: '✅ GitHub account disconnected successfully.',
      });

      const mockEvent = {
        type: 'app_home_opened' as const,
        user: userId,
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
      logger.info(`GitHub disconnected for user ${userId} in workspace ${workspaceId}`);
    } catch (error) {
      logger.error('Error disconnecting GitHub:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error disconnecting GitHub. Please try again.',
      });
    }
  });

  app.action('browse_github_repositories', async ({ ack, body, client, logger }) => {
    await ack();

    let repositoryBrowseViewId: string | undefined;

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;
      const modalMetadata = { userId, workspaceId };

      const workspaceStore = new WorkspaceStore();
      const userGithubInfo = await workspaceStore.getUserGithubInfo(workspaceId, userId);
      const hasEnvToken = !!process.env.GITHUB_TOKEN;

      // Check if we have either user GitHub info or environment token
      if (!userGithubInfo && !hasEnvToken) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: '❌ Please connect your GitHub account first.',
        });
        return;
      }

      // Use user token if available, otherwise use environment token
      const accessToken = userGithubInfo?.accessToken || process.env.GITHUB_TOKEN!;

      const loadingViewResponse = await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildRepositoryLoadingView(modalMetadata),
      });
      repositoryBrowseViewId = (loadingViewResponse as any).view?.id;

      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();
      const repositories = await githubOAuth.getRepositoriesWithMarkdown(accessToken);

      const repoOptions = repositories
        .slice(0, 10)
        .map((repo) => ({
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

    try {
      const selectedRepo = view.state.values.repository_select_block.repository_select.selected_option?.value;
      const path = view.state.values.path_input_block.path_input.value || '';

      if (!selectedRepo) {
        await ack({
          response_action: 'errors',
          errors: {
            repository_select_block: 'Please select a repository.',
          },
        });

        // Log validation error
        const metadata = JSON.parse(view.private_metadata || '{}');
        const { userId, workspaceId } = metadata;
        const { logAppHomeModalSubmit } = await import('services/common/user-interaction-logger');
        await logAppHomeModalSubmit(
          userId,
          workspaceId,
          'select_repository_modal',
          Date.now() - startTime,
          false,
          'Repository selection modal submitted without selecting a repository',
          {
            error: 'No repository selected',
            enteredPath: path,
          },
          client,
        );
        return;
      }

      await ack();

      const metadata = JSON.parse(view.private_metadata || '{}');
      const { userId, workspaceId } = metadata;

      const repoInfo = JSON.parse(selectedRepo);

      await storeGithubRepo(workspaceId, {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        url: repoInfo.url,
        path: path.trim(),
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
        path: path.trim(),
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
        const { logAppHomeModalSubmit } = await import('services/common/user-interaction-logger');
        await logAppHomeModalSubmit(
          userId,
          workspaceId,
          'select_repository_modal',
          Date.now() - startTime,
          true,
          `Repository connected but no markdown files found - ${repoInfo.owner}/${repoInfo.repo} at path: "${path.trim()}"`,
          {
            selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
            repositoryUrl: repoInfo.url,
            repositoryPath: path.trim(),
            isPrivate: repoInfo.private,
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
          const { logAppHomeModalSubmit } = await import('services/common/user-interaction-logger');
          await logAppHomeModalSubmit(
            userId,
            workspaceId,
            'select_repository_modal',
            Date.now() - startTime,
            true,
            `Successfully connected repository - ${repoInfo.owner}/${repoInfo.repo} at path: "${path.trim()}" with ${markdownFiles.length} files`,
            {
              selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
              repositoryUrl: repoInfo.url,
              repositoryPath: path.trim(),
              isPrivate: repoInfo.private,
              filesFound: markdownFiles.length,
              vectorStoreInitialized: true,
              fileNames: markdownFiles.map(f => f.name),
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
          const { logAppHomeModalSubmit } = await import('services/common/user-interaction-logger');
          await logAppHomeModalSubmit(
            userId,
            workspaceId,
            'select_repository_modal',
            Date.now() - startTime,
            false,
            `Repository connected but vector store initialization failed - ${repoInfo.owner}/${repoInfo.repo} at path: "${path.trim()}" with ${markdownFiles.length} files`,
            {
              selectedRepository: `${repoInfo.owner}/${repoInfo.repo}`,
              repositoryUrl: repoInfo.url,
              repositoryPath: path.trim(),
              isPrivate: repoInfo.private,
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
          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
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
          logger.info(`Home screen refreshed for user ${userId} after repository connection`);
        } catch (error) {
          logger.error('Error refreshing home view after repository connection:', error);
        }
      }, 1000);
    } catch (error) {
      logger.error('Error processing repository selection:', error);
      await ack({
        response_action: 'errors',
        errors: {
          repository_select_block: 'An error occurred while connecting the repository. Please try again.',
        },
      });

      // Log error
      try {
        const metadata = JSON.parse(view.private_metadata || '{}');
        const { userId, workspaceId } = metadata;
        const { logAppHomeModalSubmit } = await import('services/common/user-interaction-logger');
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
