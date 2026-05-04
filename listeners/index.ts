import type { App } from '@slack/bolt';
import appHomeHandler from './event-handlers/app-home-handler';
import appUninstalledHandler from './event-handlers/app-uninstalled-handler';
import dmHandler from './event-handlers/dm-handler';
import mentionHandler from './event-handlers/mention-handler';
import modalCloseHandler from './event-handlers/modal-close-handler';

import { registerConversationFeature } from './features/conversation';
import { registerDMFeatures } from './features/dm';
import { registerDocumentUpdateFeature } from './features/document-update';
import { registerPreferencesFeature } from './features/preferences';
import { registerQAFeature } from './features/qa';

const registerListeners = (app: App) => {
  appHomeHandler.register(app);
  mentionHandler.register(app);
  dmHandler.register(app);
  modalCloseHandler.register(app);
  appUninstalledHandler.register(app);

  registerQAFeature(app);
  registerDocumentUpdateFeature(app);
  registerPreferencesFeature(app);
  registerConversationFeature(app);
  registerDMFeatures(app);
};

export default registerListeners;
