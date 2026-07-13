import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';

export { refreshAppHome, refreshAppHomeSoon } from '../refresh';

/**
 * Server-side authorization gate for state-changing App Home controls. Hiding a
 * button in the home view is not enforcement — a demoted user (or anyone
 * replaying the action) can still trigger the handler. Returns true only for a
 * workspace manager or the workspace owner; otherwise posts an ephemeral denial
 * and returns false. Callers must `await ack()` themselves before/after as their
 * handler type requires.
 */
export const requireManagerForAction = async (params: {
  client: any;
  userId: string;
  denyText?: string;
}): Promise<boolean> => {
  const { client, userId, denyText } = params;
  const workspaceId = await getWorkspaceId(client);
  const [isUserManager, isOwner] = await Promise.all([
    isManager(workspaceId, userId),
    isWorkspaceOwner(userId, client),
  ]);
  if (isUserManager || isOwner) return true;

  try {
    await client.chat.postEphemeral({
      user: userId,
      channel: userId,
      text: denyText || "❌ You don't have permission to perform this action.",
    });
  } catch {
    // Best-effort denial notice; authorization result stands regardless.
  }
  return false;
};

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
