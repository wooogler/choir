import type { App } from '@slack/bolt';
import { WorkspaceCleanupService } from 'services/workspace/workspace-cleanup-service';

const appUninstalledCallback = async ({ body, context, logger }: any) => {
  const workspaceId = body?.team_id || body?.team?.id || context?.teamId || context?.team_id;

  if (!workspaceId) {
    logger.warn('app_uninstalled event received without a workspace id.', {
      bodyTeamId: body?.team_id,
      contextTeamId: context?.teamId,
    });
    return;
  }

  logger.info('app_uninstalled event received. Starting workspace cleanup.', { workspaceId });
  await WorkspaceCleanupService.getInstance().cleanupUninstalledWorkspace(workspaceId);
  logger.info('app_uninstalled workspace cleanup finished.', { workspaceId });
};

const register = (app: App) => {
  app.event('app_uninstalled', appUninstalledCallback);
};

export default { register };
