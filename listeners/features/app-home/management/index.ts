import type { App } from '@slack/bolt';
import { registerChoirUsersHandlers } from './choir-users-handlers';
import { registerContextKeyHandlers } from './context-key-handlers';
import { registerLanguageHandlers } from './language-handlers';
import { registerLoggingHandlers } from './logging-handlers';
import { registerManagerPromotionHandlers } from './manager-promotion-handlers';
import { registerManagersHandlers } from './managers-handlers';
import { registerOpenAISettingsHandlers } from './openai-settings-handlers';
import { registerQAChannelHandlers } from './qa-channel-handlers';
import { registerReadonlyFilesHandlers } from './readonly-files-handlers';
import { registerTabHandlers } from './tab-handlers';
import { registerUrlActionHandlers } from './url-action-handlers';

export const registerManagementHandlers = (app: App) => {
  registerManagerPromotionHandlers(app);
  registerChoirUsersHandlers(app);
  registerManagersHandlers(app);
  registerLoggingHandlers(app);
  registerOpenAISettingsHandlers(app);
  registerQAChannelHandlers(app);
  registerReadonlyFilesHandlers(app);
  registerTabHandlers(app);
  registerUrlActionHandlers(app);
  registerContextKeyHandlers(app);
  registerLanguageHandlers(app);
};
