import type { App } from "@slack/bolt";
import sampleViewCallback from "./sample-view";
import createDiscussionRoomCallback from "./create-discussion";
import createConsultationRoomCallback from "./create-consultation";

const register = (app: App) => {
  app.view("sample_view_id", sampleViewCallback);
  app.view("create_discussion_room", createDiscussionRoomCallback);
  app.view("create_consultation_room", createConsultationRoomCallback);
};

export default { register };
