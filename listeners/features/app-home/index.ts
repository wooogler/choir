import type { App } from '@slack/bolt';
import { appHomeOpenedCallback } from './home-event-handler';
import { registerGitHubHandlers } from './github-handlers';
import { registerLogDownloadHandlers } from './log-download-handlers';
import { registerManagementHandlers } from './management-handlers';
import { registerOrganizationHandlers } from './organization-handlers';

export const register = (app: App) => {
  app.event('app_home_opened', appHomeOpenedCallback);
  
  registerOrganizationHandlers(app);
  registerLogDownloadHandlers(app);
  registerGitHubHandlers(app);
  registerManagementHandlers(app);
};

export { appHomeOpenedCallback };