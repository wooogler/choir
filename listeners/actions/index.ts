import type { App } from "@slack/bolt";
import sampleActionCallback from "./sample-action";
import suggestUpdatesCallback from "./suggest-updates";
import startDiscussionCallback from "./start-discussion";
import applyUpdateCallback from "./apply-update";
const register = (app: App) => {
  app.action("sample_action_id", sampleActionCallback);
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("start_discussion", startDiscussionCallback);
  app.action("apply_update", applyUpdateCallback);
};

export default { register };
