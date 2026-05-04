import type { App } from '@slack/bolt';
import { registerGitHubHandlers } from './github';
import { appHomeOpenedCallback } from './home-event-handler';
import { registerLogDownloadHandlers } from './log-download-handlers';
import { registerManagementHandlers } from './management';
import { registerOrganizationHandlers } from './organization-handlers';

export const register = (app: App) => {
  app.event('app_home_opened', appHomeOpenedCallback);

  registerOrganizationHandlers(app);
  registerLogDownloadHandlers(app);
  registerGitHubHandlers(app);
  registerManagementHandlers(app);
};

export { appHomeOpenedCallback };
