/**
 * P0 spike, part 2: does a Google Picker selection give the app durable,
 * SERVER-SIDE access to a document it did not create?
 *
 * This is the assumption the whole "click Sync, pick your existing Doc" UX rests
 * on. The `drive.file` scope grants access to files the app created *or that the
 * user opened with it via the Picker*; the design further needs that grant to
 * survive into later background calls made with the stored refresh token, long
 * after the browser session is gone.
 *
 * To make the proof meaningful the server discards the browser's access token and
 * mints a brand-new one from the refresh token alone, using a fresh OAuth client —
 * exactly what the 3-minute poller will do days later.
 *
 * Setup (same OAuth client as drive-spike, plus two Picker-only values):
 *   export GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json
 *   export GOOGLE_PICKER_API_KEY=...      # GCP → APIs & Services → Credentials → API key
 *   export GOOGLE_PROJECT_NUMBER=...      # GCP → project settings → project number
 *
 * Run:
 *   node dist/spike-gdocs/picker-spike.js [--allow-write]
 *   # then open the printed http://127.0.0.1:5599 and pick a document
 *
 * Write probes: by default the write test is a rename-and-restore, which proves
 * write access without touching content. --allow-write additionally replaces the
 * document's content (DESTRUCTIVE — use a throwaway doc).
 */

import http from 'node:http';
import { URL } from 'node:url';
import { auth as googleAuth, drive as driveClient } from '@googleapis/drive';
import { authorize, exportMarkdown, loadClientCredentials } from './spike-common';

const PORT = Number(process.env.PORT || 5599);

/** Names drive-spike gives its own documents; picking one makes the run meaningless. */
const SPIKE_CREATED_NAME = /^CHOIR replica spike/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} (see the header comment in picker-spike.ts).`);
  }
  return value;
}

function pickerPage(config: { token: string; apiKey: string; appId: string; allowWrite: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CHOIR — Picker grant spike</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
    button { font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer; }
    pre { background: #f5f5f5; padding: 1rem; white-space: pre-wrap; word-break: break-word; }
    .warn { background: #fff3cd; padding: 0.8rem; border-left: 4px solid #e0a800; }
  </style>
</head>
<body>
  <h1>Picker grant spike</h1>
  <p>Pick a Google Doc <strong>you made yourself</strong>, before this spike existed. The server
     will throw away this page's token, mint a fresh one from the stored refresh token, and try to
     read (and write) the file you picked.</p>
  <p class="warn"><strong>Do not pick anything named &ldquo;CHOIR replica spike&rdquo;.</strong>
     The <code>drive.file</code> scope already covers files this app created, so picking one of
     those proves nothing about the Picker grant — every check would pass either way.</p>
  <p class="warn">${
    config.allowWrite
      ? 'Running with <strong>--allow-write</strong>: the content of the document you pick <strong>will be replaced</strong>. Pick a throwaway document.'
      : 'Write probe is a rename-and-restore only — your content will not be touched.'
  }</p>
  <button id="pick" disabled>Loading Picker…</button>
  <pre id="out">(no result yet)</pre>
  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    var CONFIG = ${JSON.stringify(config)};
    var out = document.getElementById('out');
    var button = document.getElementById('pick');

    gapi.load('picker', function () {
      button.disabled = false;
      button.textContent = 'Pick a Google Doc';
    });

    button.addEventListener('click', function () {
      var view = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
        .setMimeTypes('application/vnd.google-apps.document')
        .setIncludeFolders(false);
      var picker = new google.picker.PickerBuilder()
        .setAppId(CONFIG.appId)
        .setOAuthToken(CONFIG.token)
        .setDeveloperKey(CONFIG.apiKey)
        .addView(view)
        .setCallback(onPicked)
        .build();
      picker.setVisible(true);
    });

    function onPicked(data) {
      if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) return;
      var doc = data[google.picker.Response.DOCUMENTS][0];
      out.textContent = 'Verifying server-side…';
      fetch('/picked', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileId: doc[google.picker.Document.ID],
          name: doc[google.picker.Document.NAME]
        })
      })
        .then(function (r) { return r.json(); })
        .then(function (r) { out.textContent = r.report; })
        .catch(function (e) { out.textContent = 'Request failed: ' + e; });
    }
  </script>
</body>
</html>`;
}

/**
 * Runs the checks with a client that has never seen an access token — only the
 * refresh token — which is the situation every background poll is in.
 */
async function verifyServerSide(
  refreshToken: string,
  fileId: string,
  name: string,
  allowWrite: boolean,
): Promise<string> {
  const { clientId, clientSecret } = loadClientCredentials();
  const fresh = new googleAuth.OAuth2(clientId, clientSecret);
  fresh.setCredentials({ refresh_token: refreshToken });
  const drive = driveClient({ version: 'v3', auth: fresh });

  const lines: string[] = [`Picked: ${name} (${fileId})`, ''];
  let inconclusive = false;
  const record = (step: string, ok: boolean, detail: string) => {
    const line = `${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`;
    lines.push(line);
    console.log(line);
  };

  let originalName: string | undefined;

  try {
    const token = await fresh.getAccessToken();
    record('0. mint access token from refresh token alone', Boolean(token.token), token.token ? 'ok' : 'no token');
  } catch (error) {
    record('0. mint access token from refresh token alone', false, (error as Error).message);
    return lines.join('\n');
  }

  try {
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, version, modifiedTime, createdTime, trashed',
    });
    originalName = meta.data.name ?? undefined;
    record(
      '1. files.get on a picked file',
      meta.data.id === fileId,
      `name=${meta.data.name} version=${meta.data.version} created=${meta.data.createdTime}`,
    );

    // drive.file covers app-created files as well as picked ones, so a document
    // this spike made would pass every check without the Picker grant doing
    // anything. That reads as a pass but proves nothing.
    if (SPIKE_CREATED_NAME.test(meta.data.name ?? '')) {
      inconclusive = true;
    }
  } catch (error) {
    record('1. files.get on a picked file', false, (error as Error).message);
  }

  try {
    const markdown = await exportMarkdown(drive, fileId);
    record('2. files.export as markdown', markdown.length > 0, `${markdown.length} bytes exported`);
  } catch (error) {
    record('2. files.export as markdown', false, (error as Error).message);
  }

  // Non-destructive write probe: rename, then put the name back.
  if (originalName) {
    try {
      await drive.files.update({ fileId, requestBody: { name: `${originalName} (choir write probe)` }, fields: 'id' });
      await drive.files.update({ fileId, requestBody: { name: originalName }, fields: 'id' });
      record('3. write probe (rename + restore)', true, 'metadata write allowed; name restored');
    } catch (error) {
      record('3. write probe (rename + restore)', false, (error as Error).message);
    }
  }

  if (allowWrite) {
    try {
      const replaced = await drive.files.update({
        fileId,
        media: {
          mimeType: 'text/markdown',
          body: `# Replaced by the CHOIR picker spike\n\nIf you are reading this in Google Docs, content replacement on a picked file works.\n`,
        },
        fields: 'id, version',
      });
      record(
        '4. content replace on a picked file (DESTRUCTIVE)',
        replaced.data.id === fileId,
        `fileId unchanged, version=${replaced.data.version}`,
      );
    } catch (error) {
      record('4. content replace on a picked file (DESTRUCTIVE)', false, (error as Error).message);
    }
  } else {
    lines.push('SKIP  4. content replace — re-run with --allow-write on a throwaway doc to verify');
  }

  if (inconclusive) {
    lines.push(
      '',
      'INCONCLUSIVE — this document was created by the spike itself.',
      'The drive.file scope already grants access to files this app created, so the checks',
      'above would pass with or without a Picker grant. Re-run and pick a document you made',
      'yourself to actually test the grant.',
    );
  }

  lines.push('', 'Done. You can close this tab and stop the spike with Ctrl-C.');
  return lines.join('\n');
}

async function main() {
  const allowWrite = process.argv.includes('--allow-write');
  const apiKey = requireEnv('GOOGLE_PICKER_API_KEY');
  const appId = requireEnv('GOOGLE_PROJECT_NUMBER');

  const oauth2 = await authorize();
  const refreshToken = oauth2.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error(
      'No refresh token in the cached credentials. Delete scripts/spike-gdocs/.drive-spike-token.json and re-authorize.',
    );
  }

  const accessToken = (await oauth2.getAccessToken()).token;
  if (!accessToken) {
    throw new Error('Could not mint an access token for the Picker.');
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pickerPage({ token: accessToken, apiKey, appId, allowWrite }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/picked') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        void (async () => {
          try {
            const { fileId, name } = JSON.parse(body) as { fileId: string; name: string };
            console.log(`\n--- Picked ${name} (${fileId}); verifying with a fresh refresh-token client ---`);
            const report = await verifyServerSide(refreshToken, fileId, name, allowWrite);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ report }));
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ report: `Verification failed: ${(error as Error).message}` }));
          }
        })();
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  // A bare EADDRINUSE surfaces as an unhandled 'error' event and a stack dump.
  // The usual cause is an SSH tunnel for this very port that was opened on the
  // wrong host, so name the likely culprit instead of making the reader guess.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} on this machine is already taken.`);
      console.error('Find the holder with:  ss -tlnp | grep -w ' + PORT);
      console.error('If it is an `ssh -L` tunnel, that command belongs on the machine running your');
      console.error('BROWSER, not on this one. Exit that session, or run the spike on another port:');
      console.error(`  PORT=5600 node dist/spike-gdocs/picker-spike.js\n`);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nPicker spike running. Open:  http://127.0.0.1:${PORT}\n`);
    if (allowWrite) {
      console.log('--allow-write is ON: the document you pick WILL have its content replaced.\n');
    }
    console.log('Pick a Google Doc that this spike did not create, then watch this console.');
    console.log('Ctrl-C to stop.\n');
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
