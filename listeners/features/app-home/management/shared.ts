import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';

export { refreshAppHome, refreshAppHomeSoon } from '../refresh';

export const getErrorDetails = (error: unknown) => ({
  error: error instanceof Error ? error.message : 'Unknown error',
  errorStack: error instanceof Error ? error.stack : undefined,
});

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
