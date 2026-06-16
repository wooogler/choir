import { Logger } from 'services/common/logger';

const SLACK_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const SLACK_OIDC_SCOPES = 'openid profile email';

export interface SlackOidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getSlackOidcConfig(): SlackOidcConfig | null {
  const clientId = process.env.SLACK_CLIENT_ID?.trim();
  const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim();
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  if (!clientId || !clientSecret || !baseUrl) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl}/docs/auth/slack/callback`,
  };
}

export function buildSlackAuthorizeUrl(params: {
  config: SlackOidcConfig;
  state: string;
  team?: string;
}): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SLACK_OIDC_SCOPES);
  url.searchParams.set('client_id', params.config.clientId);
  url.searchParams.set('redirect_uri', params.config.redirectUri);
  url.searchParams.set('state', params.state);
  if (params.team) {
    url.searchParams.set('team', params.team);
  }
  return url.toString();
}

interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  id_token?: string;
  access_token?: string;
}

interface SlackIdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string;
  'https://slack.com/user_id'?: string;
  'https://slack.com/team_id'?: string;
  email?: string;
  name?: string;
}

function decodeIdToken(idToken: string): SlackIdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded, 'base64').toString('utf-8');
  return JSON.parse(json) as SlackIdTokenClaims;
}

export interface SlackOidcResult {
  userId: string;
  teamId?: string;
  email?: string;
  name?: string;
}

export async function exchangeSlackOidcCode(params: {
  config: SlackOidcConfig;
  code: string;
}): Promise<SlackOidcResult> {
  const body = new URLSearchParams({
    client_id: params.config.clientId,
    client_secret: params.config.clientSecret,
    code: params.code,
    redirect_uri: params.config.redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await response.json()) as SlackTokenResponse;
  if (!data.ok || !data.id_token) {
    Logger.warn('Slack OIDC token exchange failed', { error: data.error });
    throw new Error(`Slack OIDC exchange failed: ${data.error || 'unknown error'}`);
  }

  const claims = decodeIdToken(data.id_token);
  const userId = claims['https://slack.com/user_id'] || claims.sub;
  if (!userId) {
    throw new Error('Slack id_token missing user identifier');
  }

  return {
    userId,
    teamId: claims['https://slack.com/team_id'],
    email: claims.email,
    name: claims.name,
  };
}
