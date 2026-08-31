/**
 * Shared plumbing for the Google Docs replica spikes: installed-app OAuth over a
 * loopback redirect, and the markdown export/compare helpers the P0 checks are
 * built on.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { URL } from 'node:url';
import { auth as googleAuth, type drive_v3 } from '@googleapis/drive';

// The single scope under test. Deliberately NOT drive or drive.readonly: the
// point of the spike is that this one suffices for an app that only ever touches
// files it created itself or the user picked for it.
export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_CACHE = path.join(__dirname, '.drive-spike-token.json');

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Reads the OAuth desktop-app client JSON that GOOGLE_OAUTH_CLIENT points at. */
export function loadClientCredentials(): ClientCredentials {
  const clientPath = process.env.GOOGLE_OAUTH_CLIENT;
  if (!clientPath || !fs.existsSync(clientPath)) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT to the path of your OAuth desktop-app client JSON.');
  }
  const credentials = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;
  return { clientId: client_id, clientSecret: client_secret };
}

/**
 * Installed-app OAuth over a loopback redirect. Caches the refresh token next to
 * this script so repeat runs don't re-prompt. Returns the client plus the raw
 * refresh token, which the picker spike needs to prove server-side durability.
 */
export async function authorize(): Promise<InstanceType<typeof googleAuth.OAuth2>> {
  const clientPath = process.env.GOOGLE_OAUTH_CLIENT;
  if (!clientPath || !fs.existsSync(clientPath)) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT to the path of your OAuth desktop-app client JSON.');
  }

  const credentials = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;

  // Port 0 lets the OS pick a free port; the redirect URI is registered as
  // http://localhost for desktop clients, which accepts any port.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const oauth2 = new googleAuth.OAuth2(client_id, client_secret, redirectUri);

  if (fs.existsSync(TOKEN_CACHE)) {
    oauth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf-8')));
    server.close();
    return oauth2;
  }

  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  console.log(`\nOpen this URL to authorize (scope: ${SCOPES.join(' ')}):\n\n${authUrl}\n`);
  console.log('If the browser runs on another machine, the redirect to 127.0.0.1 will fail to load —');
  console.log('that is expected. Copy the whole URL out of the address bar and paste it here.\n');

  const code = await waitForAuthCode(server, redirectUri);

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(tokens), { mode: 0o600 });
  console.log(`Token cached at ${TOKEN_CACHE}`);
  return oauth2;
}

/**
 * Pulls the authorization code out of whatever the user has to hand: the raw
 * code, the query string, or the entire redirect URL copied from a browser that
 * could not reach our loopback listener.
 */
export function extractAuthCode(input: string): string | null {
  const trimmed = input.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return null;

  if (trimmed.includes('code=')) {
    const match = trimmed.match(/[?&]code=([^&\s]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  // A bare code. Google's look like `4/0A...`; reject obvious pastes of something else.
  return /\s/.test(trimmed) ? null : trimmed;
}

/**
 * Resolves the authorization code from whichever channel produces it first: the
 * loopback redirect (when the browser shares a host with this process) or a paste
 * on stdin (when it does not, which is the usual case for a remote checkout).
 */
async function waitForAuthCode(server: http.Server, redirectUri: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const fromLoopback = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const requested = new URL(req.url || '/', redirectUri);
      const received = requested.searchParams.get('code');
      const error = requested.searchParams.get('error');
      res.end(received ? 'Authorized. You can close this tab.' : `Authorization failed: ${error}`);
      received ? resolve(received) : reject(new Error(error || 'no code'));
    });
  });

  const fromPaste = new Promise<string>((resolve) => {
    const ask = () => {
      rl.question('Paste the redirect URL (or just the code) here: ', (answer) => {
        const parsed = extractAuthCode(answer);
        if (parsed) {
          resolve(parsed);
          return;
        }
        console.log('Could not find a code in that. Try again.');
        ask();
      });
    };
    ask();
  });

  try {
    return await Promise.race([fromLoopback, fromPaste]);
  } finally {
    rl.close();
    server.close();
  }
}

/**
 * Exports a Google Doc as markdown — the accurate measuring instrument for this
 * design (the Drive MCP connector's read tool is a lossy natural-language
 * rendering and cannot be used for formatting verdicts).
 */
export async function exportMarkdown(drive: drive_v3.Drive, fileId: string): Promise<string> {
  const response = await drive.files.export({ fileId, mimeType: 'text/markdown' }, { responseType: 'text' });
  const data = response.data as unknown;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  return JSON.stringify(data);
}

export interface TextDelta {
  identical: boolean;
  /** 1-indexed line of the first difference, or 0 when identical. */
  firstDiffLine: number;
  summary: string;
}

/**
 * Compares two export snapshots and describes the first divergence. Used to tell
 * "no human edit" from "human edit" and, in the idempotency checks, to expose
 * whether Docs' markdown serializer is deterministic at all.
 */
export function compareText(a: string, b: string): TextDelta {
  if (a === b) {
    return { identical: true, firstDiffLine: 0, summary: `identical (${a.length} bytes)` };
  }

  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const limit = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < limit; i += 1) {
    if (linesA[i] !== linesB[i]) {
      const preview = (line: string | undefined) =>
        line === undefined ? '(missing)' : JSON.stringify(line.length > 90 ? `${line.slice(0, 90)}…` : line);
      return {
        identical: false,
        firstDiffLine: i + 1,
        summary:
          `differ at line ${i + 1} (${a.length} vs ${b.length} bytes, ` +
          `${linesA.length} vs ${linesB.length} lines)\n      A: ${preview(linesA[i])}\n      B: ${preview(linesB[i])}`,
      };
    }
  }
  return { identical: false, firstDiffLine: limit, summary: 'differ only in trailing content' };
}

/**
 * Strips base64 image payloads down to a length+hash marker. Docs' markdown
 * export embeds images as `[imageN]: <data:image/png;base64,...>` reference
 * definitions; if only the encoding of those payloads is unstable, the design can
 * normalize them away, so the checks report stable-vs-unstable separately.
 */
export function normalizeDataUrls(markdown: string): string {
  return markdown.replace(/data:([^;]+);base64,([A-Za-z0-9+/=]+)/g, (_match, mime, payload) => {
    return `data:${mime};base64,<${payload.length} bytes>`;
  });
}
