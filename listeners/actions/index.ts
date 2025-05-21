import type { App } from "@slack/bolt";
import startDiscussionCallback from "./discussion/start-discussion";
import startConsultationCallback from "./discussion/start-consultation";
import {
  selectUserCallback,
  addManagerCallback,
  removeManagerCallback,
} from "./permissions/manage-permissions";
import {
  githubRepoUrlInputCallback,
  testGithubConnectionCallback,
} from "./github/github-connection";
import { diagnoseVectorStoreAction } from "./vector-store/vector-store-diagnosis";
import {
  rebuildVectorCacheAction,
  resetVectorStoreAction,
} from "./vector-store/vector-store-management";
import { handleCheckMessages } from "./general/check-messages";
import { handleSelectMessages } from "./general/select-messages";

const register = (app: App) => {
  app.action("start_discussion", startDiscussionCallback);
  app.action("start_discussion_selected", startDiscussionCallback);

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

  // 메시지 선택 메시지
  app.action("check_messages", handleCheckMessages);
  app.action("select_messages", handleSelectMessages);
};

export default { register };
