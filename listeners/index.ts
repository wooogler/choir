import type { App } from '@slack/bolt';
// import actions from "./actions"; // 삭제 예정
import appHomeHandler from './event-handlers/app-home-handler';
import { clearChatCommand, handleClearChat } from './event-handlers/command-handler';
import dmHandler from './event-handlers/dm-handler';
// import views from "./views"; // 삭제 예정
import mentionHandler from './event-handlers/mention-handler';

import { registerConversationFeature } from './features/conversation';
import { registerDocumentUpdateFeature } from './features/document-update';
import { registerPreferencesFeature } from './features/preferences';
import { registerQAFeature } from './features/qa';
// import { registerKnowledgeExtractionFeature } from "./features/knowledge-extraction"; // knowledge-extraction은 아직

const registerListeners = (app: App) => {
  // Event Handlers
  appHomeHandler.register(app);
  mentionHandler.register(app); // mention-handler 내부에서 일부 document-update 액션을 직접 등록하고 있음. 이를 document-update feature로 옮길지 검토 필요.
  dmHandler.register(app);
  app.command(clearChatCommand.command, handleClearChat);

  // Feature-based Actions/Views
  registerQAFeature(app);
  registerDocumentUpdateFeature(app);
  registerPreferencesFeature(app);
  registerConversationFeature(app);
};

export default registerListeners;
