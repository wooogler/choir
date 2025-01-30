import type { App } from "@slack/bolt";
import emojiReactionCallback from "./emoji-reaction";

const register = (app: App) => {
  app.event("reaction_added", emojiReactionCallback);
};

export default { register };
