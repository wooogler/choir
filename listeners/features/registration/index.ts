import type { App } from '@slack/bolt';
import { approveChoirRegistrationAction } from './approve-registration-action';
import { declineChoirRegistrationAction } from './decline-registration-action';
import { requestChoirAccessAction } from './request-access-action';
import { APPROVE_REGISTRATION_ACTION_ID, DECLINE_REGISTRATION_ACTION_ID, REQUEST_ACCESS_ACTION_ID } from './shared';

export const registerRegistrationFeature = (app: App) => {
  app.action(REQUEST_ACCESS_ACTION_ID, requestChoirAccessAction);
  app.action(APPROVE_REGISTRATION_ACTION_ID, approveChoirRegistrationAction);
  app.action(DECLINE_REGISTRATION_ACTION_ID, declineChoirRegistrationAction);
};

export { handleNonUserAccess } from './non-user-access';
