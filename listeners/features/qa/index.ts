import type { App } from "@slack/bolt";
import { askToChannelModalCallback } from "./ask-to-channel-modal-action";
import { askToChannelSubmitCallback } from "./ask-to-channel-modal-view";
import { askToOthersModalCallback } from "./ask-to-others-modal-action";
import { askToOthersSubmitCallback } from "./ask-to-others-modal-view";
// question-handler는 직접적인 action/view가 아니며, message-router.ts에서 직접 호출됨

export const registerQAFeature = (app: App) => {
  // Actions
  app.action("ask_to_channel_modal", askToChannelModalCallback);
  app.action("ask_to_others_modal", askToOthersModalCallback);

  // Views
  app.view("ask_to_channel_submit", askToChannelSubmitCallback);
  app.view("ask_to_others_submit", askToOthersSubmitCallback);
};

// message-router.ts 등에서 question-handler.ts를 직접 사용할 수 있도록 export 유지
export * from "./question-handler";
// 아래 export 들은 registerQAFeature 함수가 사용하므로 유지할 필요 없음.
// export * from "./ask-to-channel-modal-action";
// export * from "./ask-to-channel-modal-view";
// export * from "./ask-to-others-modal-action";
// export * from "./ask-to-others-modal-view"; 