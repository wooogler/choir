import { signPayload, verifyPayload } from 'services/docs-editor/signed-payload';

/**
 * Proof that a link request came from a manager who just went through the file
 * picker.
 *
 * Linking is destructive: the linked document's content is immediately replaced
 * with the GitHub version. Without this, a bare POST with any fileId the
 * workspace account can reach — including a real working document someone
 * granted months ago — would overwrite it, with only a client-side dialog
 * standing in the way. The nonce is issued alongside the picker token and
 * expires quickly, so a link must follow a deliberate pick.
 */

const PICKER_NONCE_TTL_MS = 5 * 60 * 1000;
const PURPOSE = 'gdocs-picker-nonce';

interface PickerNoncePayload {
  workspaceId: string;
  userId: string;
}

export function issuePickerNonce(workspaceId: string, userId: string): string {
  return signPayload<PickerNoncePayload>(PURPOSE, { workspaceId, userId }, PICKER_NONCE_TTL_MS);
}

export function verifyPickerNonce(value: string, workspaceId: string, userId: string): boolean {
  const result = verifyPayload<PickerNoncePayload>(PURPOSE, value);
  // Bound to the issuing manager as well as the workspace: one manager's nonce
  // must not authorize a link performed as someone else.
  return result.ok && result.payload.workspaceId === workspaceId && result.payload.userId === userId;
}
