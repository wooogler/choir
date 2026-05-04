import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';
import { appHomeOpenedCallback } from '../../../event-handlers/app-home-handler';

export const getErrorDetails = (error: unknown) => ({
  error: error instanceof Error ? error.message : 'Unknown error',
  errorStack: error instanceof Error ? error.stack : undefined,
});

export const refreshAppHomeSoon = (params: {
  client: any;
  logger: any;
  userId: string;
  reason: string;
}) => {
  const { client, logger, userId, reason } = params;

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
      logger.info(`Home screen refreshed for user ${userId} after ${reason}`);
    } catch (error) {
      logger.error(`Error refreshing home view after ${reason}:`, error);
    }
  }, 1000);
};

export const logManagementButtonError = async (params: {
  userId: string;
  actionId: string;
  actionLabel: string;
  startTime: number;
  error: unknown;
  client: any;
  logger: any;
}) => {
  const { userId, actionId, actionLabel, startTime, error, client, logger } = params;

  try {
    const workspaceId = await getWorkspaceId(client);
    await logAppHomeButtonClick(
      userId,
      workspaceId,
      actionId,
      Date.now() - startTime,
      false,
      actionLabel,
      getErrorDetails(error),
      client,
    );
  } catch (logError) {
    logger.error('Failed to log error:', logError);
  }
};

export const logManagementModalError = async (params: {
  userId: string;
  callbackId: string;
  message: string;
  startTime: number;
  error: unknown;
  client: any;
  logger: any;
}) => {
  const { userId, callbackId, message, startTime, error, client, logger } = params;

  try {
    const workspaceId = await getWorkspaceId(client);
    await logAppHomeModalSubmit(
      userId,
      workspaceId,
      callbackId,
      Date.now() - startTime,
      false,
      message,
      getErrorDetails(error),
      client,
    );
  } catch (logError) {
    logger.error('Failed to log error:', logError);
  }
};
