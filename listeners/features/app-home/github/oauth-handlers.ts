import type { App } from '@slack/bolt';
import { GitHubOAuthDeviceFlow } from 'services/github/oauth-device-flow';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { refreshAppHome } from './shared';

export const registerGitHubOAuthHandlers = (app: App) => {
  app.action('connect_personal_github', async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      const githubOAuth = GitHubOAuthDeviceFlow.getInstance();

      const deviceCode = await githubOAuth.requestDeviceCode();

      const openResult = await client.views.open({
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
                  text: '💡 This window will update once you complete the authorization on GitHub — you can then close it.',
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
      const openedViewId = openResult.view?.id;

      // Update the still-open device-code modal to a terminal state. The Slack API
      // can't force-close a modal, so we replace its contents instead.
      const setModalResult = async (text: string) => {
        if (!openedViewId) return;
        await client.views
          .update({
            view_id: openedViewId,
            view: {
              type: 'modal',
              callback_id: 'github_device_code_modal',
              title: { type: 'plain_text', text: 'Connect GitHub' },
              close: { type: 'plain_text', text: 'Close' },
              blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
            },
          })
          .catch((updateError) => logger.warn('Failed to update GitHub device-code modal:', updateError));
      };

      // The poll blocks for up to the device code's lifetime; run it detached but
      // guard every branch so a notification failure can't reject unhandled and
      // crash the process.
      setTimeout(() => {
        void (async () => {
          try {
            const tokenResponse = await githubOAuth.pollForAccessToken(deviceCode.device_code, deviceCode.interval);
            const user = await githubOAuth.getUserInfo(tokenResponse.access_token);

            const workspaceStore = new WorkspaceStore();
            await workspaceStore.setUserGithubToken(workspaceId, userId, {
              accessToken: tokenResponse.access_token,
              user,
            });

            await setModalResult(
              `✅ *GitHub account connected!*\nWelcome, ${user.name || user.login}. You can close this window.`,
            );
            await client.chat
              .postEphemeral({
                user: userId,
                channel: userId,
                text: `✅ GitHub account connected successfully! Welcome, ${user.name || user.login}!`,
              })
              .catch((notifyError) => logger.warn('Failed to send GitHub connection confirmation:', notifyError));

            await refreshAppHome({ client, logger, userId, reason: 'GitHub connection' }).catch((refreshError) =>
              logger.warn('Failed to refresh App Home after GitHub connection:', refreshError),
            );
            logger.info(`GitHub connected for user ${userId} in workspace ${workspaceId}`);
          } catch (error) {
            logger.error('Error during GitHub OAuth flow:', error);
            await setModalResult('❌ *GitHub connection failed.*\nPlease close this window and try again.');
            await client.chat
              .postEphemeral({
                user: userId,
                channel: userId,
                text: '❌ GitHub connection failed. Please try again.',
              })
              .catch((notifyError) => logger.warn('Failed to send GitHub connection failure notice:', notifyError));
          }
        })();
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

      await refreshAppHome({ client, logger, userId, reason: 'GitHub disconnection' });
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
};
