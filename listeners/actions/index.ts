import type { App } from "@slack/bolt";
import suggestUpdatesCallback from "./suggest-updates";
import { handleDocumentSelection } from "./document-selection";
import { applySelectedToGithubAction } from "./document-update";
import startDiscussionCallback from "./start-discussion";
import {
  selectUserCallback,
  addManagerCallback,
  removeManagerCallback,
} from "./manage-permissions";
import {
  githubRepoUrlInputCallback,
  testGithubConnectionCallback,
} from "./github-connection";
import { diagnoseVectorStoreAction } from "./vector-store-diagnosis";
import {
  rebuildVectorCacheAction,
  resetVectorStoreAction,
} from "./vector-store-management";

const register = (app: App) => {
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("start_discussion", startDiscussionCallback);
  app.action("start_discussion_selected", startDiscussionCallback);
  app.action("apply_selected_to_github", applySelectedToGithubAction);
  app.action("document_selection", handleDocumentSelection);

  // 관리자 권한 관리 액션 등록
  app.action("select_user_for_permission", selectUserCallback);
  app.action("add_manager_permission", addManagerCallback);
  app.action("remove_manager_permission", removeManagerCallback);

  // GitHub 저장소 연동 액션 등록
  app.action("github_repo_url_input", githubRepoUrlInputCallback);
  app.action("test_github_connection", testGithubConnectionCallback);

  // 벡터 스토어 진단 액션 등록
  app.action("diagnose_vector_store", diagnoseVectorStoreAction);

  // 벡터 스토어 관리 액션 등록
  app.action("rebuild_vector_cache", rebuildVectorCacheAction);
  app.action("reset_vector_store", resetVectorStoreAction);
};

export default { register };
