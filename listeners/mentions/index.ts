import type { App } from "@slack/bolt";
import appMentionCallback from "./app-mention";

const register = (app: App) => {
  app.event("app_mention", appMentionCallback);
};

export default { register };
