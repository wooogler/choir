import type { App } from '@slack/bolt';

export const registerUrlActionHandlers = (app: App) => {
  app.action('start_chat_url', async ({ ack, logger }) => {
    await ack();
    logger.info('Start chat URL button clicked - handled by deep link');
  });

  app.action('open_dm_url', async ({ ack, logger }) => {
    await ack();
    logger.info('Open DM URL button clicked - handled by deep link');
  });

  app.action('open_private_dm_url', async ({ ack, logger }) => {
    await ack();
    logger.info('Open private DM URL button clicked - handled by deep link');
  });
};
