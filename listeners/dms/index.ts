import type { App } from "@slack/bolt";
import dmCallback from "./dm-answer";

const register = (app: App) => {
  app.event("message", dmCallback);
};

export default { register };
