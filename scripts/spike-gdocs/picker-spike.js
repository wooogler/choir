"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const node_url_1 = require("node:url");
const drive_1 = require("@googleapis/drive");
const spike_common_1 = require("./spike-common");
const PORT = Number(process.env.PORT || 5599);
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Set ${name} (see the header comment in picker-spike.ts).`);
    }
    return value;
}
function pickerPage(config) {
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
  <p>Pick a Google Doc that this spike did <strong>not</strong> create. The server will then
     throw away this page's token, mint a fresh one from the stored refresh token, and try to
     read (and write) the file you picked.</p>
  <p class="warn">${config.allowWrite
        ? 'Running with <strong>--allow-write</strong>: the content of the document you pick <strong>will be replaced</strong>. Pick a throwaway document.'
        : 'Write probe is a rename-and-restore only — your content will not be touched.'}</p>
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
async function verifyServerSide(refreshToken, fileId, name, allowWrite) {
    const { clientId, clientSecret } = (0, spike_common_1.loadClientCredentials)();
    const fresh = new drive_1.auth.OAuth2(clientId, clientSecret);
    fresh.setCredentials({ refresh_token: refreshToken });
    const drive = (0, drive_1.drive)({ version: 'v3', auth: fresh });
    const lines = [`Picked: ${name} (${fileId})`, ''];
    const record = (step, ok, detail) => {
        const line = `${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`;
        lines.push(line);
        console.log(line);
    };
    let originalName;
    try {
        const token = await fresh.getAccessToken();
        record('0. mint access token from refresh token alone', Boolean(token.token), token.token ? 'ok' : 'no token');
    }
    catch (error) {
        record('0. mint access token from refresh token alone', false, error.message);
        return lines.join('\n');
    }
    try {
        const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType, version, modifiedTime, trashed' });
        originalName = meta.data.name ?? undefined;
        record('1. files.get on a picked file', meta.data.id === fileId, `name=${meta.data.name} version=${meta.data.version} mimeType=${meta.data.mimeType}`);
    }
    catch (error) {
        record('1. files.get on a picked file', false, error.message);
    }
    try {
        const markdown = await (0, spike_common_1.exportMarkdown)(drive, fileId);
        record('2. files.export as markdown', markdown.length > 0, `${markdown.length} bytes exported`);
    }
    catch (error) {
        record('2. files.export as markdown', false, error.message);
    }
    // Non-destructive write probe: rename, then put the name back.
    if (originalName) {
        try {
            await drive.files.update({ fileId, requestBody: { name: `${originalName} (choir write probe)` }, fields: 'id' });
            await drive.files.update({ fileId, requestBody: { name: originalName }, fields: 'id' });
            record('3. write probe (rename + restore)', true, 'metadata write allowed; name restored');
        }
        catch (error) {
            record('3. write probe (rename + restore)', false, error.message);
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
            record('4. content replace on a picked file (DESTRUCTIVE)', replaced.data.id === fileId, `fileId unchanged, version=${replaced.data.version}`);
        }
        catch (error) {
            record('4. content replace on a picked file (DESTRUCTIVE)', false, error.message);
        }
    }
    else {
        lines.push('SKIP  4. content replace — re-run with --allow-write on a throwaway doc to verify');
    }
    lines.push('', 'Done. You can close this tab and stop the spike with Ctrl-C.');
    return lines.join('\n');
}
async function main() {
    const allowWrite = process.argv.includes('--allow-write');
    const apiKey = requireEnv('GOOGLE_PICKER_API_KEY');
    const appId = requireEnv('GOOGLE_PROJECT_NUMBER');
    const oauth2 = await (0, spike_common_1.authorize)();
    const refreshToken = oauth2.credentials.refresh_token;
    if (!refreshToken) {
        throw new Error('No refresh token in the cached credentials. Delete scripts/spike-gdocs/.drive-spike-token.json and re-authorize.');
    }
    const accessToken = (await oauth2.getAccessToken()).token;
    if (!accessToken) {
        throw new Error('Could not mint an access token for the Picker.');
    }
    const server = node_http_1.default.createServer((req, res) => {
        const url = new node_url_1.URL(req.url || '/', `http://127.0.0.1:${PORT}`);
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
                        const { fileId, name } = JSON.parse(body);
                        console.log(`\n--- Picked ${name} (${fileId}); verifying with a fresh refresh-token client ---`);
                        const report = await verifyServerSide(refreshToken, fileId, name, allowWrite);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ report }));
                    }
                    catch (error) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ report: `Verification failed: ${error.message}` }));
                    }
                })();
            });
            return;
        }
        res.writeHead(404);
        res.end('not found');
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
