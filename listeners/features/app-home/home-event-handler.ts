import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getWorkspaceId } from 'services/slack';
import { buildHomeView } from './home-view-builder';

export const appHomeOpenedCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'app_home_opened'>) => {
  logger.info(`App home opened for user ${event.user}, tab: ${event.tab}`);

  if (event.tab !== 'home') return;

  try {
    const workspaceId = await getWorkspaceId(client);
    const blocks = await buildHomeView(client, logger, workspaceId, event.user);

    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks,
      },
    });
  } catch (error) {
    logger.error('Error publishing home view:', error);
  }
};