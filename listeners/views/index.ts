import type { App } from "@slack/bolt";
import createDiscussionRoomCallback from "./create-discussion";
import createConsultationRoomCallback from "./create-consultation";
import { showUpdateEditorModal, handleUpdateEditorSubmission } from "./update-editor";

const register = (app: App) => {
  app.view("create_discussion_room", createDiscussionRoomCallback);
  app.view("create_consultation_room", createConsultationRoomCallback);
  app.view("update_editor_submission", handleUpdateEditorSubmission);
  app.action("edit_update", showUpdateEditorModal);
};

export default { register };
