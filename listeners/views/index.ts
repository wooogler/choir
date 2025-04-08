import type { App } from "@slack/bolt";
import sampleViewCallback from "./sample-view";
import createDiscussionRoomCallback from "./create-discussion";

const register = (app: App) => {
  app.view("sample_view_id", sampleViewCallback);
  app.view("create_discussion_room", createDiscussionRoomCallback);
};

export default { register };
