import type { App } from "@slack/bolt";
import { handleAsQuestionCallback } from "./handle-as-question-action";
import { handleAsUpdateRequestCallback } from "./handle-as-update-request-action";
// general-conversation-handler는 직접적인 action/view가 아니며, message-router.ts에서 직접 호출됨

export const registerConversationFeature = (app: App) => {
  // Actions
  app.action("handle_as_question", handleAsQuestionCallback);
  app.action("handle_as_update_request", handleAsUpdateRequestCallback);
};

// message-router.ts 등에서 general-conversation-handler.ts를 직접 사용할 수 있도록 export 유지
export * from "./general-conversation-handler"; 