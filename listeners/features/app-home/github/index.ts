import type { App } from '@slack/bolt';
import { registerGitHubOAuthHandlers } from './oauth-handlers';
import { registerRepositorySelectionHandlers } from './repo-selection-handlers';

export const registerGitHubHandlers = (app: App) => {
  registerGitHubOAuthHandlers(app);
  registerRepositorySelectionHandlers(app);
};
