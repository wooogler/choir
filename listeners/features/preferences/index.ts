import type { App } from '@slack/bolt';
import { githubRepoUrlInputCallback, testGithubConnectionCallback } from './github-connection';
import { addManagerCallback, removeManagerCallback, selectUserCallback } from './manage-permissions';
import qaChannelActions from './qa-channel-actions'; // default export { register }
import { diagnoseVectorStoreAction } from './vector-store/vector-store-diagnosis';
import {
  normalizeMarkdownFilesAction,
  rebuildVectorCacheAction,
  resetVectorStoreAction,
} from './vector-store/vector-store-management';

export const registerPreferencesFeature = (app: App) => {
  // Manage Permissions
  app.action('select_user_for_permission', selectUserCallback);
  app.action('add_manager_permission', addManagerCallback);
  app.action('remove_manager_permission', removeManagerCallback);

  // GitHub Connection
  app.action('github_repo_url_input', githubRepoUrlInputCallback);
  app.action('test_github_connection', testGithubConnectionCallback);

  // QA Channel Actions
  qaChannelActions.register(app); // qa-channel-actions.ts가 { register }를 default export 한다고 가정

  // Vector Store Diagnosis
  app.action('diagnose_vector_store', diagnoseVectorStoreAction);

  // Vector Store Management
  app.action('rebuild_vector_cache', rebuildVectorCacheAction);
  app.action('reset_vector_store', resetVectorStoreAction);
  app.action('normalize_markdown_files', normalizeMarkdownFilesAction);
};

// 기존 export * 제거 (이제 registerPreferencesFeature를 통해 등록)
// export * from "./manage-permissions";
// export * from "./github-connection";
// export * from "./qa-channel-actions";
// export * from "./vector-store/vector-store-diagnosis";
// export * from "./vector-store/vector-store-management";
