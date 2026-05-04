import { appHomeOpenedCallback } from '../../../event-handlers/app-home-handler';

export const refreshAppHome = async (params: {
  client: any;
  logger: any;
  userId: string;
  reason: string;
}) => {
  const { client, logger, userId, reason } = params;
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
};
