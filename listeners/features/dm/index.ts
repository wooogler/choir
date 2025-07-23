import type { App } from '@slack/bolt';
import { cancelClearDMCallback, confirmClearDMCallback } from './clear-action';

export function registerDMFeatures(app: App) {
  // Clear 버튼 액션 핸들러
  app.action('confirm_clear_dm', confirmClearDMCallback);
  app.action('cancel_clear_dm', cancelClearDMCallback);
}
