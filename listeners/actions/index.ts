import type { App } from "@slack/bolt";
import sampleActionCallback from "./sample-action";
import suggestUpdatesCallback from "./suggest-updates";
import startDiscussionCallback from "./start-discussion";
import applyUpdateCallback from "./apply-update";
import {
  selectUserCallback,
  addManagerCallback,
  removeManagerCallback,
} from "./manage-permissions";
import {
  githubRepoUrlInputCallback,
  testGithubConnectionCallback,
} from "./github-connection";

const register = (app: App) => {
  app.action("sample_action_id", sampleActionCallback);
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("start_discussion", startDiscussionCallback);
  app.action("apply_update", applyUpdateCallback);

  // 관리자 권한 관리 액션 등록
  app.action("select_user_for_permission", selectUserCallback);
  app.action("add_manager_permission", addManagerCallback);
  app.action("remove_manager_permission", removeManagerCallback);

  // GitHub 저장소 연동 액션 등록
  app.action("github_repo_url_input", githubRepoUrlInputCallback);
  app.action("test_github_connection", testGithubConnectionCallback);
};

export default { register };
