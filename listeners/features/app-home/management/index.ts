import type { App } from '@slack/bolt';
import { registerChoirUsersHandlers } from './choir-users-handlers';
import { registerLoggingHandlers } from './logging-handlers';
import { registerManagerPromotionHandlers } from './manager-promotion-handlers';
import { registerManagersHandlers } from './managers-handlers';
import { registerReadonlyFilesHandlers } from './readonly-files-handlers';
import { registerUrlActionHandlers } from './url-action-handlers';

export const registerManagementHandlers = (app: App) => {
  registerManagerPromotionHandlers(app);
  registerChoirUsersHandlers(app);
  registerManagersHandlers(app);
  registerLoggingHandlers(app);
  registerReadonlyFilesHandlers(app);
  registerUrlActionHandlers(app);
};
