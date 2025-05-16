import type { App } from "@slack/bolt";
import appMentionCallback from "./app-mention";
import suggestUpdatesCallback from "./handlers/suggest-updates";
import { handleDocumentSelection } from "./handlers/document-selection";
import { applySelectedToGithubAction } from "./handlers/document-update";

const register = (app: App) => {
  app.event("app_mention", appMentionCallback);
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("document_selection", handleDocumentSelection);
  app.action("apply_selected_to_github", applySelectedToGithubAction);
};

export default { register };
