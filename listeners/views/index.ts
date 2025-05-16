import type { App } from "@slack/bolt";
import createDiscussionRoomCallback from "./create-discussion";
import createConsultationRoomCallback from "./create-consultation";

const register = (app: App) => {
  app.view("create_discussion_room", createDiscussionRoomCallback);
  app.view("create_consultation_room", createConsultationRoomCallback);
};

export default { register };
