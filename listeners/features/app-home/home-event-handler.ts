import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getWorkspaceId } from 'services/slack';
import { ensureWorkspaceInitialized } from 'services/slack/workspace-bootstrap';
import { buildHomeView } from './home-view-builder';

export const appHomeOpenedCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<'app_home_opened'>) => {
  logger.info(`App home opened for user ${event.user}, tab: ${event.tab}`);

  if (event.tab !== 'home') return;

  try {
    // Do NOT pass the opener as a fallback manager: initial manager rights must
    // go to the verified workspace owner only, never to whoever happens to open
    // the App Home first. If the owner can't be resolved the workspace stays
    // uninitialized and the password-promotion flow is the escape hatch.
    const bootstrap = await ensureWorkspaceInitialized(client);
    const workspaceId = bootstrap.workspaceId || (await getWorkspaceId(client));
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
