/**
 * Spike: verifies the parts of the GitHub → Google Docs replica design that the
 * Drive MCP connector cannot answer, because it authenticates with broad scopes
 * and its update tool only changes metadata.
 *
 * Specifically it proves (or disproves) that with ONLY the `drive.file` scope —
 * the non-sensitive one that avoids restricted-scope verification and the annual
 * CASA assessment — an app can:
 *
 *   1. create a folder,
 *   2. create a Google Doc inside it by importing markdown (--html for the HTML path),
 *   3. REPLACE that doc's content in place and keep the same fileId/URL,
 *   4. set a reader permission so the replica is read-only,
 *   5. do all of the above inside a shared drive (optional, --shared-drive).
 *
 * Step 3 is the load-bearing one: the whole design assumes a stable Doc URL
 * across syncs. Step 5 is the likely blocker for org-wide sharing.
 *
 * Setup:
 *   pnpm add -D @googleapis/drive
 *   # GCP console → create an OAuth 2.0 Client ID of type "Desktop app",
 *   # download the JSON, and point GOOGLE_OAUTH_CLIENT at it.
 *   export GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json
 *
 * Run:
 *   npx tsc --ignoreConfig scripts/spike-gdocs/*.ts --outDir dist/spike-gdocs \
 *     --rootDir scripts/spike-gdocs --module commonjs --target es2020 \
 *     --esModuleInterop --skipLibCheck --types node
 *   node dist/spike-gdocs/drive-spike.js [--shared-drive <driveId>] [--keep] [--html]
 *
 * (The repo's ts-node cannot run this directly — see the note at the bottom of
 * scripts/spike-gdocs/README.md.)
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { auth as googleAuth, drive as driveClient } from '@googleapis/drive';
import { renderMarkdownToDocsHtml } from './markdown-to-docs-html';

// The single scope under test. Deliberately NOT drive or drive.readonly: the
// point of the spike is that this one suffices for an app that only ever touches
// files it created itself.
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_CACHE = path.join(__dirname, '.drive-spike-token.json');

interface Args {
  sharedDriveId?: string;
  keep: boolean;
  useHtml: boolean;
}

function parseArgs(argv: string[]): Args {
  const sharedDriveIndex = argv.indexOf('--shared-drive');
  return {
    sharedDriveId: sharedDriveIndex >= 0 ? argv[sharedDriveIndex + 1] : undefined,
    keep: argv.includes('--keep'),
    useHtml: argv.includes('--html'),
  };
}

/**
 * Installed-app OAuth over a loopback redirect. Caches the refresh token next to
 * this script so repeat runs don't re-prompt.
 */
async function authorize() {
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

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const requested = new URL(req.url || '/', redirectUri);
      const received = requested.searchParams.get('code');
      const error = requested.searchParams.get('error');
      res.end(received ? 'Authorized. You can close this tab.' : `Authorization failed: ${error}`);
      server.close();
      received ? resolve(received) : reject(new Error(error || 'no code'));
    });
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(tokens), { mode: 0o600 });
  console.log(`Token cached at ${TOKEN_CACHE}`);
  return oauth2;
}

const BANNER = '이 문서는 GitHub에서 자동 생성된 복제본입니다. 여기서 편집한 내용은 반영되지 않습니다.';

/**
 * Builds the upload body for a doc. Markdown is the default because it measured
 * better than HTML on lists, blockquotes, rules and heading cleanliness (see
 * README); --html switches to the rendered-HTML path, which only wins on code
 * blocks.
 */
function uploadBody(markdown: string, title: string, useHtml: boolean): { mimeType: string; body: string } {
  if (useHtml) {
    return { mimeType: 'text/html', body: renderMarkdownToDocsHtml(markdown, { title, banner: BANNER }) };
  }
  return { mimeType: 'text/markdown', body: `*${BANNER}*\n\n${markdown}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auth = await authorize();
  const drive = driveClient({ version: 'v3', auth });

  // Shared-drive calls need these flags on every request, so build them once.
  const sharedDriveOpts = args.sharedDriveId ? { supportsAllDrives: true } : {};
  const results: Array<{ step: string; ok: boolean; detail: string }> = [];
  const record = (step: string, ok: boolean, detail: string) => {
    results.push({ step, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
  };

  let folderId: string | undefined;
  let docId: string | undefined;

  // 1. Folder creation — the replica mirrors the repo's directory tree.
  try {
    const folder = await drive.files.create({
      requestBody: {
        name: `choir-spike-${Date.now()}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: args.sharedDriveId ? [args.sharedDriveId] : undefined,
      },
      fields: 'id, name, driveId',
      ...sharedDriveOpts,
    });
    folderId = folder.data.id ?? undefined;
    record('1. create folder', true, `id=${folderId} driveId=${folder.data.driveId ?? '(My Drive)'}`);
  } catch (error) {
    record('1. create folder', false, (error as Error).message);
  }

  // 2. Create the Doc by importing markdown (mimeType asks Drive to convert).
  try {
    const created = await drive.files.create({
      requestBody: {
        name: 'CHOIR replica spike',
        mimeType: 'application/vnd.google-apps.document',
        parents: folderId ? [folderId] : undefined,
      },
      media: uploadBody('# 최초 버전\n\n이 문단은 곧 교체됩니다.\n\n```ts\nconst before = 1;\n```\n', 'v1', args.useHtml),
      fields: 'id, webViewLink, mimeType',
      ...sharedDriveOpts,
    });
    docId = created.data.id ?? undefined;
    record(`2. import ${args.useHtml ? 'HTML' : 'markdown'} as Doc`, created.data.mimeType === 'application/vnd.google-apps.document', `id=${docId} url=${created.data.webViewLink}`);
  } catch (error) {
    record(`2. import ${args.useHtml ? 'HTML' : 'markdown'} as Doc`, false, (error as Error).message);
  }

  // 3. THE load-bearing check: replace content in place, same fileId and URL.
  if (docId) {
    try {
      const before = docId;
      const updated = await drive.files.update({
        fileId: docId,
        media: uploadBody('# 두 번째 버전\n\n내용이 통째로 교체되었습니다.\n\n```ts\nconst after = 2;\n```\n', 'v2', args.useHtml),
        fields: 'id, webViewLink, modifiedTime',
        ...sharedDriveOpts,
      });
      const stable = updated.data.id === before;
      record('3. replace content in place', stable, stable ? `fileId unchanged (${before}), url=${updated.data.webViewLink}` : `fileId CHANGED: ${before} → ${updated.data.id}`);
    } catch (error) {
      record('3. replace content in place', false, (error as Error).message);
    }
  }

  // 4. Read-only sharing, so viewers can't edit a doc whose edits would be lost.
  if (docId) {
    try {
      await drive.permissions.create({
        fileId: docId,
        requestBody: { type: 'anyone', role: 'reader' },
        ...sharedDriveOpts,
      });
      record('4. set reader permission', true, 'type=anyone role=reader');
    } catch (error) {
      record('4. set reader permission', false, (error as Error).message);
    }
  }

  // 5. Confirm drive.file really does keep access to what we created — and
  //    nothing else. A files.list restricted to our folder should return the doc.
  if (folderId) {
    try {
      const listed = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        ...(args.sharedDriveId ? { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'drive', driveId: args.sharedDriveId } : {}),
      });
      const found = (listed.data.files || []).some((f) => f.id === docId);
      record('5. list app-created files', found, `${listed.data.files?.length ?? 0} file(s) visible in folder`);
    } catch (error) {
      record('5. list app-created files', false, (error as Error).message);
    }
  }

  if (!args.keep) {
    for (const id of [docId, folderId].filter(Boolean) as string[]) {
      await drive.files.delete({ fileId: id, ...sharedDriveOpts }).catch(() => undefined);
    }
    console.log('\nCleaned up spike files (pass --keep to inspect them by hand).');
  } else if (docId) {
    console.log(`\nKept: https://docs.google.com/document/d/${docId}/edit`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
