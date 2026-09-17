import type { App } from '@slack/bolt';
import { MANUAL_APPLIED_ACTION_ID, MANUAL_DECLINED_ACTION_ID } from 'services/google/manual-apply';
import { gdocsManualAppliedAction, gdocsManualDeclinedAction } from './manual-apply-actions';

/**
 * Buttons on the Google Docs cards CHOIR sends managers.
 *
 * The drift review cards carry link buttons only and need no handler here; these
 * two belong to the manual-apply card, which asks a person to do something CHOIR
 * cannot do itself.
 */
export const registerGoogleDocsFeature = (app: App) => {
  app.action(MANUAL_APPLIED_ACTION_ID, gdocsManualAppliedAction);
  app.action(MANUAL_DECLINED_ACTION_ID, gdocsManualDeclinedAction);
};
