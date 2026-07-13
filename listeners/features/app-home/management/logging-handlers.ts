import type { App } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { logManagementButtonError, refreshAppHomeSoon, requireManagerForAction } from './shared';

export const registerLoggingHandlers = (app: App) => {
  app.action('toggle_logging', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const currentLogging = await workspaceStore.getLoggingEnabled(workspaceId);
      const newLogging = !currentLogging;

      await workspaceStore.setLoggingEnabled(workspaceId, newLogging);

      await client.chat.postEphemeral({
        user: body.user.id,
        channel: body.user.id,
        text: `${newLogging ? '\u2705' : '\u274c'} Logging has been ${newLogging ? 'enabled' : 'disabled'}. Please refresh your app home to see the changes.`,
      });

      refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'logging toggle' });

      logger.info('Logging setting toggled', {
        workspaceId,
        userId: body.user.id,
        enabled: newLogging,
      });

      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'toggle_logging',
        Date.now() - startTime,
        true,
        'Toggle Logging',
        {
          previousState: currentLogging,
          newState: newLogging,
        },
        client,
      );
    } catch (error) {
      logger.error('Error toggling logging setting:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '\u274c Error toggling logging setting. Please try again.',
        });
      }

      await logManagementButtonError({
        userId: body.user.id,
        actionId: 'toggle_logging',
        actionLabel: 'Toggle Logging',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
