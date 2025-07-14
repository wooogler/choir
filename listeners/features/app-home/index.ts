import type { App } from '@slack/bolt';
import { registerGitHubHandlers } from './github-handlers';
import { appHomeOpenedCallback } from './home-event-handler';
import { registerLogDownloadHandlers } from './log-download-handlers';
import { registerManagementHandlers } from './management-handlers';
import { registerOrganizationHandlers } from './organization-handlers';

export const register = (app: App) => {
  console.log('🏠 [DEBUG] Registering app-home feature...');
  
  app.event('app_home_opened', appHomeOpenedCallback);

  console.log('🏠 [DEBUG] Registering organization handlers...');
  registerOrganizationHandlers(app);
  
  console.log('🏠 [DEBUG] Registering log download handlers...');
  registerLogDownloadHandlers(app);
  
  console.log('🏠 [DEBUG] Registering GitHub handlers...');
  registerGitHubHandlers(app);
  
  console.log('🏠 [DEBUG] Registering management handlers...');
  registerManagementHandlers(app);
  
  console.log('🏠 [DEBUG] App-home feature registration complete!');
};

export { appHomeOpenedCallback };
