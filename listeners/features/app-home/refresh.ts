import type { Logger } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { getWorkspaceId } from 'services/slack';
import { ensureWorkspaceInitialized } from 'services/slack/workspace-bootstrap';
import { buildHomeView } from './home-view-builder';

interface RefreshParams {
  client: WebClient;
  logger: Logger;
  userId: string;
  reason: string;
}

export async function refreshAppHome(params: RefreshParams): Promise<void> {
  const { client, logger, userId, reason } = params;
  try {
    const bootstrap = await ensureWorkspaceInitialized(client, userId);
    const workspaceId = bootstrap.workspaceId || (await getWorkspaceId(client));
    const blocks = await buildHomeView(client, logger, workspaceId, userId);
    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks },
    });
    logger.info(`App Home refreshed for user ${userId} after ${reason}`);
  } catch (error) {
    logger.error(`Failed to refresh App Home for user ${userId} after ${reason}:`, error);
  }
}

// Fire-and-forget refresh used after a modal submission, so the closing modal
// has time to settle before the home view re-renders.
export function refreshAppHomeSoon(params: RefreshParams, delayMs = 1000): void {
  setTimeout(() => {
    void refreshAppHome(params);
  }, delayMs);
}
