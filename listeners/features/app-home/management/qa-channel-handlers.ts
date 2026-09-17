import type { App, BlockAction, ChannelsSelectAction } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId, isManager, isWorkspaceOwner, setQAChannel } from 'services/slack';
import { refreshAppHomeSoon } from '../refresh';
import { logManagementButtonError } from './shared';

export const registerQAChannelHandlers = (app: App) => {
  app.action<BlockAction<ChannelsSelectAction>>('select_qa_channel', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const userId = body.user.id;
    const t = tForRequest(context);

    try {
      const workspaceId = await getWorkspaceId(client);
      const [isUserManager, isOwner] = await Promise.all([
        isManager(workspaceId, userId),
        isWorkspaceOwner(userId, client),
      ]);

      if (!isUserManager && !isOwner) {
        logger.warn(`Unauthorized Q&A channel change attempt by user ${userId}`);
        await client.chat.postEphemeral({
          channel: userId,
          user: userId,
          text: t('appHome.management.qaChannel.error.permission'),
        });
        return;
      }

      const selectedChannelId = body.actions[0]?.selected_channel;
      if (!selectedChannelId) {
        return;
      }

      let channelName = selectedChannelId;
      try {
        const channelInfo = await client.conversations.info({ channel: selectedChannelId });
        if (!channelInfo.channel) {
          throw new Error('Channel not found');
        }
        channelName = channelInfo.channel.name || selectedChannelId;
      } catch (channelError) {
        logger.warn(`Could not access channel ${selectedChannelId}:`, channelError);
        await client.chat.postMessage({
          channel: userId,
          text: t('appHome.management.qaChannel.error.access'),
        });
        return;
      }

      await setQAChannel(workspaceId, selectedChannelId);

      await client.chat.postMessage({
        channel: userId,
        text: t('appHome.management.qaChannel.success', { channel: channelName }),
      });

      refreshAppHomeSoon({ client, logger, userId, reason: 'Q&A channel update' });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        'select_qa_channel',
        Date.now() - startTime,
        true,
        'Set Q&A Channel',
        { selectedChannelId, channelName },
        client,
      );
    } catch (error) {
      logger.error('Error setting Q&A channel:', error);
      await client.chat.postMessage({
        channel: userId,
        text: t('appHome.management.qaChannel.error.generic'),
      });
      await logManagementButtonError({
        userId,
        actionId: 'select_qa_channel',
        actionLabel: 'Set Q&A Channel',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
