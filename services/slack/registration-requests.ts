/**
 * registration-requests.ts
 *
 * Pending "access request" records for people who are not yet CHOIR users. When a
 * non-user messages CHOIR we offer them a one-click "Request Access" button and
 * hold their original question here until a manager approves (then it is answered
 * automatically) or declines (then it is discarded).
 *
 * Backed by the generic session store, keyed by `${workspaceId}:${userId}`. The
 * record intentionally carries `workspaceId`/`userId` as fields so that
 * purgeWorkspaceSessions() reaps it on uninstall (its key form is not one the
 * purge matches by string, but the `data.workspaceId` branch is).
 */
import { SessionType, getSessionData, removeSessionData, storeSessionData } from 'services/common';

export type RegistrationStatus =
  | 'offered' // shown the Request Access button; not yet clicked
  | 'pending' // request clicked, managers notified, awaiting decision
  | 'declined'; // a manager declined

export interface RegistrationRequestOrigin {
  channelId: string;
  isPublic: boolean; // true when asked via @mention in a channel, false for a DM
}

export interface ManagerMessageRef {
  channel: string;
  ts: string;
}

export interface RegistrationRequest {
  workspaceId: string;
  userId: string;
  userName: string;
  status: RegistrationStatus;
  heldQuestion?: string; // the original question, answered on approval; never sent to the LLM before then
  origin: RegistrationRequestOrigin;
  managerMessageInfo: Record<string, ManagerMessageRef>; // manager DM coords, for syncing all messages on a decision
  createdAt: number;
  updatedAt: number;
}

// 30 days. The session store has no "never expires", so a real duration is
// required; long enough that a slow manager doesn't drop a legitimate request.
const REGISTRATION_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const requestKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

export function getRegistrationRequest(workspaceId: string, userId: string): RegistrationRequest | null {
  return getSessionData(
    requestKey(workspaceId, userId),
    SessionType.REGISTRATION_REQUEST,
  ) as RegistrationRequest | null;
}

export function saveRegistrationRequest(request: RegistrationRequest): void {
  request.updatedAt = Date.now();
  storeSessionData(
    requestKey(request.workspaceId, request.userId),
    request,
    SessionType.REGISTRATION_REQUEST,
    REGISTRATION_REQUEST_TTL_MS,
  );
}

/**
 * Deletes the pending request. Doubles as an atomic approval claim: the underlying
 * DELETE returns `changes > 0` only for the caller that actually removed the row,
 * so when two managers approve at once exactly one gets `true` and performs the
 * approval + auto-answer once; the other sees `false` and backs off.
 */
export function clearRegistrationRequest(workspaceId: string, userId: string): boolean {
  return removeSessionData(requestKey(workspaceId, userId), SessionType.REGISTRATION_REQUEST);
}
