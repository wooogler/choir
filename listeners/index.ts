import type { App } from '@slack/bolt';
// import actions from "./actions"; // 삭제 예정
import appHomeHandler from './event-handlers/app-home-handler';
import dmHandler from './event-handlers/dm-handler';
import mentionHandler from './event-handlers/mention-handler';
import modalCloseHandler from './event-handlers/modal-close-handler';

import { registerConversationFeature } from './features/conversation';
import { registerDocumentUpdateFeature } from './features/document-update';
import { registerPreferencesFeature } from './features/preferences';
import { registerQAFeature } from './features/qa';
// import { registerKnowledgeExtractionFeature } from "./features/knowledge-extraction"; // knowledge-extraction은 아직

const registerListeners = (app: App) => {
  console.log('🚀 [DEBUG] Starting to register all listeners...');
  
  // Global middleware to catch all actions for debugging
  app.action(/.+/, async ({ action, ack, body, next }) => {
    console.log('🔍 [DEBUG] Action intercepted:', {
      action_id: (action as any).action_id,
      type: (action as any).type,
      userId: body.user?.id,
      bodyType: body.type
    });
    await next();
  });
  
  // Event Handlers
  console.log('🚀 [DEBUG] Registering event handlers...');
  appHomeHandler.register(app);
  mentionHandler.register(app); // mention-handler 내부에서 일부 document-update 액션을 직접 등록하고 있음. 이를 document-update feature로 옮길지 검토 필요.
  dmHandler.register(app);
  modalCloseHandler.register(app);

  // Feature-based Actions/Views
  console.log('🚀 [DEBUG] Registering feature-based actions/views...');
  registerQAFeature(app);
  registerDocumentUpdateFeature(app);
  registerPreferencesFeature(app);
  registerConversationFeature(app);
  
  console.log('🚀 [DEBUG] All listeners registered successfully!');
};

export default registerListeners;
