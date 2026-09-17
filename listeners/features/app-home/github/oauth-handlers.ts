import type { App } from '@slack/bolt';
import { GitHubOAuthDeviceFlow } from 'services/github/oauth-device-flow';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { refreshAppHome } from './shared';

export const registerGitHubOAuthHandlers = (app: App) => {
  app.action('connect_personal_github', async ({ ack, body, client, context, logger }) => {
    await ack();

    // The device flow keeps talking to the same person for minutes after the
    // click — through the modal, then the DM — so the translator is bound once
    // here and captured by the poll below, rather than re-resolved per message.
    const t = tForRequest(context);

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
            text: t('appHome.github.connect.title'),
          },
          close: {
            type: 'plain_text',
            text: t('common.button.cancel'),
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.github.connect.intro'),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                // The verification URL is GitHub's, not ours to translate: it is
                // pre-formatted as a link here and handed over as one opaque param.
                text: t('appHome.github.connect.steps', {
                  link: `<${deviceCode.verification_uri}|${deviceCode.verification_uri}>`,
                  code: deviceCode.user_code,
                }),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.github.connect.expiry', { count: Math.floor(deviceCode.expires_in / 60) }),
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: t('appHome.github.connect.hint'),
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
              title: { type: 'plain_text', text: t('appHome.github.connect.title') },
              close: { type: 'plain_text', text: t('common.button.close') },
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

            await setModalResult(t('appHome.github.connect.success', { name: user.name || user.login }));
            await client.chat
              .postEphemeral({
                user: userId,
                channel: userId,
                text: t('appHome.github.connect.successNotice', { name: user.name || user.login }),
              })
              .catch((notifyError) => logger.warn('Failed to send GitHub connection confirmation:', notifyError));

            await refreshAppHome({ client, logger, userId, reason: 'GitHub connection' }).catch((refreshError) =>
              logger.warn('Failed to refresh App Home after GitHub connection:', refreshError),
            );
            logger.info(`GitHub connected for user ${userId} in workspace ${workspaceId}`);
          } catch (error) {
            logger.error('Error during GitHub OAuth flow:', error);
            await setModalResult(t('appHome.github.connect.failure'));
            await client.chat
              .postEphemeral({
                user: userId,
                channel: userId,
                text: t('appHome.github.connect.failureNotice'),
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
        text: t('appHome.github.connect.startError'),
      });
    }
  });

  app.action('disconnect_personal_github', async ({ ack, body, client, context, logger }) => {
    await ack();

    const t = tForRequest(context);

    try {
      const workspaceId = await getWorkspaceId(client);
      const userId = body.user.id;

      const workspaceStore = new WorkspaceStore();
      await workspaceStore.removeUserGithubToken(workspaceId, userId);

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.github.disconnect.success'),
      });

      await refreshAppHome({ client, logger, userId, reason: 'GitHub disconnection' });
      logger.info(`GitHub disconnected for user ${userId} in workspace ${workspaceId}`);
    } catch (error) {
      logger.error('Error disconnecting GitHub:', error);
      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: t('appHome.github.disconnect.error'),
      });
    }
  });
};
