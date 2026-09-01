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
`http://localhost` redirect URL, so plain `pnpm dev:local` cannot sign you in. The cookie
is host-scoped, so one obtained on the tunnel domain is not sent to `localhost` either.

```bash
pnpm dev:tunnel
```

publishes the Vite server through the ngrok domain taken from `DOCS_BASE_URL` in
`.env.development`, so the callback lands on the same origin the browser is already on.
Requirements:

- the domain is reserved on the ngrok account (`manifest.dev.json` already uses
  `lion-supreme-cleanly.ngrok-free.app`)
- `https://<domain>/docs/auth/slack/callback` is registered as a redirect URL on the
  Slack app
- for Google Docs sync, `https://<domain>/docs/auth/google/callback` is an authorized
  redirect URI on the Google OAuth client

The tunnel points at Vite rather than at the node app on purpose: OAuth callbacks and
the HMR websocket then share one origin.

## Security notes

- **Never run the Vite dev server with `--host`.** Vite serves arbitrary repository
  files under `/@fs/`. `web/vite.config.ts` denies `data/**`, `*.db`, `.choir-*key*` and
  `.env*` for that reason — without it, anything that can reach port 5173 can read
  `data/dev/.choir-docs-editor-key` and forge a manager session cookie for any user.
- `pnpm dev:local` binds the node app to `127.0.0.1`. `pnpm dev:socket` does not; it
  binds `0.0.0.0`.
- `pnpm dev:tunnel` deliberately adds no authentication shortcut. If a dev-only sign-in
  route is ever added, it must never be reachable through the tunnel.

## What local development cannot exercise

- **GitHub webhooks.** Not registered in Socket Mode at all (`app.ts`). Use the
  "Reload from GitHub" button in App Home instead.
- **Images in Slack replies, and image import from Drive replicas.** Both are fetched by
  a third-party server, not by the browser, so a localhost origin drops them.
- **Google Docs sync**, unless `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
  are added to `.env.development` — it currently has neither. `DOCS_BASE_URL` must also
  be set: `getRedirectUri()` throws without it, and that is on the path of *every* Drive
  call, not just the consent screen.
- The drift poller sweeps every 3 minutes by default; set `GOOGLE_DRIFT_POLL_MS` lower
  when iterating on the review flow.

## ts-node configuration

Every `pnpm dev:*` script runs through ts-node, configured in the `ts-node` block of
`tsconfig.json` (ignored by `tsc`):

- `files: true` — without it the ambient declarations under `src/types` are invisible
  and startup dies on `TS2307: Cannot find module 'node-diff3'`.
- `transpileOnly: true` — drops a ~9 second type-check from every restart. Type errors
  still surface in the editor and in `pnpm verify`.
- `compilerOptions.rootDir` — required by TypeScript 6, which otherwise infers the
  common source directory from the single entry file.
