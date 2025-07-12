import type { App } from '@slack/bolt';
import { GithubService } from 'services/github';
import { GitHubOAuthDeviceFlow } from 'services/github/oauth-device-flow';
import { getWorkspaceId, storeGithubRepo } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

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

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

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

      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();
      const repositories = await githubOAuth.getRepositoriesWithMarkdown(accessToken);

      const repoOptions = repositories.slice(0, 10).map((repo) => ({
        text: {
          type: 'plain_text' as const,
          text: `${repo.full_name}${repo.private ? ' 🔒' : ''}`,
        },
        value: JSON.stringify({
          owner: repo.owner.login,
          repo: repo.name,
          url: repo.html_url,
          private: repo.private,
        }),
      }));

      if (repoOptions.length === 0) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: '❌ No repositories found with write access.',
        });
        return;
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'select_repository_modal',
          title: {
            type: 'plain_text',
            text: 'Select Repository',
          },
          submit: {
            type: 'plain_text',
            text: 'Connect Repository',
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
                text: '📂 *Select a GitHub repository to connect*\n\nChoose one of your repositories that you have write access to.',
              },
            },
            {
              type: 'input',
              block_id: 'repository_select_block',
              element: {
                type: 'static_select',
                action_id: 'repository_select',
                placeholder: {
                  type: 'plain_text',
                  text: 'Choose a repository...',
                },
                options: repoOptions,
              },
              label: {
                type: 'plain_text',
                text: 'Repository',
              },
            },
            {
              type: 'input',
              block_id: 'path_input_block',
              element: {
                type: 'plain_text_input',
                action_id: 'path_input',
                placeholder: {
                  type: 'plain_text',
                  text: 'docs/ (optional - leave empty for root)',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Path in Repository',
              },
              optional: true,
            },
          ],
          private_metadata: JSON.stringify({
            userId,
            workspaceId,
          }),
        },
      });
    } catch (error) {
      logger.error('Error browsing GitHub repositories:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: '❌ Error loading repositories. Please try again.',
      });
    }
  });

  app.view('select_repository_modal', async ({ ack, body, client, logger, view }) => {
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
      } else {
        const success = await vectorStore.initialize(markdownFiles, false, true);

        if (success) {
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: `✅ Successfully connected to ${repoInfo.owner}/${repoInfo.repo} and loaded ${markdownFiles.length} files!`,
          });
        } else {
          await client.chat.postEphemeral({
            user: userId,
            channel: userId,
            text: '⚠️ Repository connected but failed to load documents. Please try refreshing.',
          });
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
    }
  });
};
