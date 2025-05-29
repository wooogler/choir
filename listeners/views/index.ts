import type { App } from "@slack/bolt";
import createDiscussionRoomCallback from "./create-discussion";
import createConsultationRoomCallback from "./create-consultation";
import updateEditorSubmit from "./update-editor";
import { handleMessageSelectionModal } from "./message-selection-modal";
import { handleKnowledgeEditModal } from "./knowledge-edit-submit";
import askToChannelSubmit from "./ask-to-channel-submit";
import askToOthersSubmit from "./ask-to-others-submit";

const register = (app: App) => {
  app.view("create_discussion_room", createDiscussionRoomCallback);
  app.view("create_consultation_room", createConsultationRoomCallback);
  app.view("message_selection_modal", handleMessageSelectionModal);
  app.view("knowledge_edit_modal", handleKnowledgeEditModal);
  
  // Register modal submission handlers
  updateEditorSubmit.register(app);
  askToChannelSubmit.register(app);
  askToOthersSubmit.register(app);
};

export default { register };
