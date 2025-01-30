import type { App } from "@slack/bolt";
import sampleViewCallback from "./sample-view";
import startDiscussionModalCallback from "./start-discussion-modal";

const register = (app: App) => {
  app.view("sample_view_id", sampleViewCallback);
  app.view("start_discussion_modal", startDiscussionModalCallback);
};

export default { register };
