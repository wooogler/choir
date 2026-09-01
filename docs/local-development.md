# Local development

How to exercise CHOIR — the Slack app *and* the docs viewer — without deploying.

## The loop

```bash
pnpm dev:local
```

Two processes, tied together so Ctrl-C stops both:

| Process | Port | What it serves |
| --- | --- | --- |
| CHOIR node app under `nodemon` | `127.0.0.1:3031` | Slack (Socket Mode), `/api/*`, `/docs/auth/*` |
| Vite dev server | `localhost:5173` | the React viewer in `web/`, with hot reload |

The browser only ever talks to Vite. Vite proxies `/api`, `/docs/auth`, `/assets`,
`/healthz`, `/readyz` and `/slack` back to the node app, and serves the SPA shell for
`/docs/:workspaceId/:filePath` — the viewer reads its route straight off
`window.location.pathname`, so those URLs have to resolve.

The result: a change under `web/` is a hot reload, and a change to a `.ts` file is a
~8 second app restart. Neither one needs `pnpm build:web` and neither one needs a deploy.

The app runs against `.env.development` with `CHOIR_DATA_DIR=data/dev` and its own
SQLite database, so it never touches production state. It does connect to the **real**
Slack workspace configured in that file.

## Signing in

The docs viewer is gated on a signed session cookie, minted only by
`/docs/auth/slack/callback` after a real Slack OIDC round trip. Slack will not accept an
`http://localhost` redirect URL, so on a local loop there is no way to complete that
round trip — the SPA loads and then every `/api` call 401s.

`pnpm dev:local` therefore turns on `/docs/auth/dev-login`, which mints the cookie
directly. Open the URL the script prints:

    http://localhost:5173/docs/auth/dev-login?workspace=<workspaceId>&user=<userId>

The workspace id is in the app's startup log. See `services/docs-editor/dev-login.ts`
for the gates; the route refuses to register whenever `CHOIR_DEV_TUNNEL_HOST` is set,
so `pnpm dev:tunnel` gets the real Slack flow and no bypass.

`pnpm dev:tunnel` publishes the Vite server through the domain in
`CHOIR_DEV_TUNNEL_HOST`, and sets `DOCS_BASE_URL` to match, so OAuth callbacks land on
the origin the browser is already on. It needs that domain reserved on the ngrok account
and `https://<domain>/docs/auth/slack/callback` registered as a redirect URL on the Slack
app — both already true for `lion-supreme-cleanly.ngrok-free.app` (`manifest.dev.json`).
In this mode the real Slack sign-in works and dev-login does not exist.

The tunnel points at Vite rather than at the node app on purpose: OAuth callbacks and
the HMR websocket then share one origin.

## Google Docs sync against real Drive

The OAuth client in GCP project `choir-507215` is a **desktop ("installed") client**, so
Google accepts only loopback redirect URIs from it — `http://localhost:5173/...` is
accepted and any `https://` host, including the ngrok domain, is rejected with
`redirect_uri_mismatch`. Measured against Google's authorize endpoint:

| redirect_uri | |
| --- | --- |
| `http://localhost:5173/docs/auth/google/callback` | accepted |
| `http://127.0.0.1:5599` (what the P0 spike used) | accepted |
| `https://lion-supreme-cleanly.ngrok-free.app/docs/auth/google/callback` | rejected |
| any other `https://` host (control) | rejected |

`pnpm dev:local` sets `DOCS_BASE_URL=http://localhost:5173`, which lands in the accepted
column, so `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`
and `GOOGLE_PROJECT_NUMBER` in `.env.development` are all that is needed — no GCP console
change, because `http://localhost` is already the client's registered redirect URI and
desktop clients accept any port and path under it.

Consequence: **real Google Docs sync and `pnpm dev:tunnel` cannot be combined on this
client.** Connect the Google account from `pnpm dev:local`. To reach Google through the
tunnel, add a second OAuth client of type **Web application** in project `choir-507215`
with `https://<your ngrok domain>/docs/auth/google/callback` as an authorized redirect
URI, and point `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` at it.

## Testing Google Docs sync without Google

```bash
pnpm dev:local --fake-google   # terminal 1
pnpm gdocs:seed                # link a repo document to a fake replica
pnpm gdocs:edit                # play the part of someone typing in Docs
pnpm gdocs:reset               # start over
```

`--fake-google` preloads `scripts/dev/fake-google.ts`, which replaces
`services/google/drive-client` with a file-backed fake (`data/dev/fake-drive.json`)
and the GitHub write path with one that commits straight into the workspace mirror.
It also drops the drift sweep to every 5 seconds and turns on `/docs/auth/dev-login`,
so the whole state machine — `synced → drifted → pending-review → committed` — runs
in seconds with no Google account, no GCP project and no GitHub push rights.

`pnpm dev:local --fake-google` prints a `/docs/auth/dev-login?workspace=…&user=…` URL.
That route mints a docs session directly; it exists only because Slack will not accept
a localhost callback. It is fenced (see `services/docs-editor/dev-login.ts`) and
`--fake-google` cannot be combined with `--tunnel`.

What this does **not** prove: Google's export dialect. A real replica round trip is
markdown → Docs → markdown and comes back subtly different — list markers, escaping,
trailing whitespace — which is precisely what delta extraction has to survive. The fake
reads back exactly what was written. Rehearse that part with `pnpm dev:tunnel` against a
real Drive account before shipping.

`pnpm gdocs:reset` unlinks the documents and empties the fake Drive, but it does not
undo an approved edit: that was a real write to `data/dev/workspaces/<id>/repo`. Use
"Reload from GitHub" in App Home to restore the mirror.

## Security notes

- **Never run the Vite dev server with `--host`.** Vite serves arbitrary repository
  files under `/@fs/`. `web/vite.config.ts` denies `data/**`, `*.db`, `.choir-*key*` and
  `.env*` for that reason — without it, anything that can reach port 5173 can read
  `data/dev/.choir-docs-editor-key` and forge a manager session cookie for any user.
- `pnpm dev:local` binds the node app to `127.0.0.1`. `pnpm dev:socket` does not; it
  binds `0.0.0.0`.
- `pnpm dev:tunnel` adds no authentication shortcut, and `scripts/dev-local.sh` refuses
  `--tunnel --fake-google` together: `/docs/auth/dev-login` mints a session for any known
  user, and publishing that through a tunnel would put an authentication bypass on the
  public internet. The route also refuses to register when `CHOIR_DEV_TUNNEL_HOST` is set.
- The fakes under `scripts/dev/` throw on load when `NODE_ENV=production`.

## What local development cannot exercise

- **GitHub webhooks.** Not registered in Socket Mode at all (`app.ts`). Use the
  "Reload from GitHub" button in App Home instead.
- **Images in Slack replies, and image import from Drive replicas.** Both are fetched by
  a third-party server, not by the browser, so a localhost origin drops them.
- **Google Docs sync against real Drive**, unless `GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET` are added to `.env.development` — it currently has
  neither. `DOCS_BASE_URL` must also be set: `getRedirectUri()` throws without it, and
  that is on the path of *every* Drive call, not just the consent screen. Use
  `--fake-google` above for the everyday loop.
- The drift poller sweeps every 3 minutes by default, and does not start at all unless
  `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are set. `--fake-google`
  supplies inert placeholders and sets `GOOGLE_DRIFT_POLL_MS=5000`.

## ts-node configuration

Every `pnpm dev:*` script runs through ts-node, configured in the `ts-node` block of
`tsconfig.json` (ignored by `tsc`):

- `files: true` — without it the ambient declarations under `src/types` are invisible
  and startup dies on `TS2307: Cannot find module 'node-diff3'`.
- `transpileOnly: true` — drops a ~9 second type-check from every restart. Type errors
  still surface in the editor and in `pnpm verify`.
- `compilerOptions.rootDir` — required by TypeScript 6, which otherwise infers the
  common source directory from the single entry file.
