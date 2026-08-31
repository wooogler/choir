import { AppConfig } from '@/config';
import { drive as driveClient, auth as googleAuth } from '@googleapis/drive';
import { Logger } from 'services/common/logger';
import { WorkspaceStore } from 'services/workspace/workspace-store';

/**
 * OAuth for the one Google account a workspace syncs replicas through.
 *
 * Only `drive.file` is requested. Google classifies it as non-sensitive, so this
 * integration needs neither restricted-scope verification nor the annual CASA
 * assessment — the reason the replica direction is cheap to ship and the reason
 * this list must not grow. The connected account's address is read from
 * `drive.about.get`, which `drive.file` already covers, rather than by adding a
 * profile scope.
 */
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super('Google Drive sync is not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)');
    this.name = 'GoogleNotConfiguredError';
  }
}

export function getRedirectUri(): string {
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('DOCS_BASE_URL must be set to complete the Google OAuth flow');
  }
  return `${baseUrl}/docs/auth/google/callback`;
}

function createClient(): OAuth2Client {
  const { clientId, clientSecret, configured } = AppConfig.getGoogleConfig();
  if (!configured) {
    throw new GoogleNotConfiguredError();
  }
  return new googleAuth.OAuth2(clientId, clientSecret, getRedirectUri());
}

/**
 * `access_type: offline` with `prompt: consent` because we need a refresh token
 * every time: Google only returns one on the first consent unless consent is
 * re-requested, and a manager re-connecting after a revoke would otherwise get an
 * access token that expires in an hour and no way to renew it.
 */
export function buildAuthUrl(state: string): string {
  return createClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_DRIVE_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export interface ExchangedCredential {
  refreshToken: string;
  email?: string;
}

export async function exchangeCodeForCredential(code: string): Promise<ExchangedCredential> {
  const client = createClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token; the account may already be connected elsewhere');
  }
  client.setCredentials(tokens);

  let email: string | undefined;
  try {
    const about = await driveClient({ version: 'v3', auth: client }).about.get({ fields: 'user(emailAddress)' });
    email = about.data.user?.emailAddress ?? undefined;
  } catch (error) {
    // Cosmetic only — the connection works without knowing which account it is.
    Logger.warn('Could not read the connected Google account address', { error: (error as Error).message });
  }

  return { refreshToken: tokens.refresh_token, email };
}

/**
 * Builds a client for a workspace's stored credential, or null when the
 * workspace has not connected an account or its token has been rejected. Callers
 * treat null as "this workspace is not syncing" rather than as an error, so a
 * disconnected workspace costs nothing on every poll.
 */
export async function getWorkspaceClient(workspaceId: string): Promise<OAuth2Client | null> {
  const auth = await new WorkspaceStore().getGoogleAuth(workspaceId);
  if (!auth || auth.broken) {
    return null;
  }

  const client = createClient();
  client.setCredentials({ refresh_token: auth.refreshToken });
  return client;
}

/**
 * Whether an error means the stored refresh token is dead rather than that a
 * single call failed. Google reports this as `invalid_grant`, which no amount of
 * retrying fixes — the manager has to re-connect.
 */
export function isCredentialRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const responseError = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return responseError === 'invalid_grant' || /invalid_grant/i.test(message);
}

/**
 * Marks the workspace credential dead so every replica trigger stops calling
 * Drive until a manager reconnects. Safe to call on any failure: it only acts on
 * `invalid_grant`.
 */
export async function noteCredentialFailure(workspaceId: string, error: unknown): Promise<boolean> {
  if (!isCredentialRejected(error)) {
    return false;
  }
  await new WorkspaceStore().setGoogleAuthBroken(workspaceId, true);
  Logger.warn('Google credential rejected; workspace replica sync paused until reconnect', { workspaceId });
  return true;
}

/** Best-effort revoke at Google, then forget the credential locally. */
export async function disconnectWorkspace(workspaceId: string): Promise<void> {
  const store = new WorkspaceStore();
  const auth = await store.getGoogleAuth(workspaceId);

  if (auth?.refreshToken) {
    try {
      const client = createClient();
      await client.revokeToken(auth.refreshToken);
    } catch (error) {
      // An already-revoked or expired token 400s. Clearing locally is what
      // matters; leaving the record behind would be worse than a stale grant.
      Logger.warn('Google token revoke failed; clearing the stored credential anyway', {
        workspaceId,
        error: (error as Error).message,
      });
    }
  }

  await store.clearGoogleAuth(workspaceId);
}
