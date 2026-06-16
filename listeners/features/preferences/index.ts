import type { App } from '@slack/bolt';
import {
  normalizeMarkdownFilesAction,
  rebuildQmdIndexAction,
  reloadFromGithubAction,
} from '../index-management/qmd-index-management';

export const registerPreferencesFeature = (app: App) => {
  app.action('reload_from_github', reloadFromGithubAction);
  app.action('rebuild_qmd_index', rebuildQmdIndexAction);
  app.action('normalize_markdown_files', normalizeMarkdownFilesAction);
};
