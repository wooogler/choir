# CHOIR

CHOIR is a Slack bot for organization knowledge workflows. It indexes markdown documents from GitHub, answers questions against that document set, and can turn Slack conversations into document update suggestions.

## Core capabilities

- Answer questions from GitHub-backed markdown documentation
- Suggest document updates from Slack conversations
- Refresh the document index automatically from GitHub webhook events
- Provide manager controls in Slack App Home

## Stack

- TypeScript
- Slack Bolt
- OpenAI
- GitHub API via Octokit
- FAISS-based vector search by default, with optional QMD retrieval

## Getting started

### 1. Install dependencies

```bash
git clone https://github.com/wooogler/choir.git
cd choir
pnpm install
```

### 2. Configure environment variables

```bash
cp env.sample .env
```

Minimum variables for local development:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `OPENAI_API_KEY`

Optional but commonly used:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `MANAGER_PROMOTION_PASSWORD`
- `CHOIR_CONSENT_FORM_URL`
- `SLACK_APP_ID`

QMD question-answer retrieval can be enabled explicitly with `RETRIEVAL_PROVIDER=qmd`.
To use QMD for document-update anchoring as well, set `UPDATE_RETRIEVAL_PROVIDER=qmd`.

`env.sample` documents the full set currently used by the app. CHOIR does not use a server-wide GitHub token for repository access in multi-workspace mode; each manager connects their own GitHub account.

### 3. Create the Slack app

1. Open <https://api.slack.com/apps/new>.
2. Choose `From an app manifest`.
3. Paste the contents of `manifest.json`.
4. Install the app into your workspace.

If you plan to run in HTTP mode, update the manifest request URLs before installing:

- Events: `https://your-host/slack/events`
- Interactivity: `https://your-host/slack/events`

### 4. Run the app

For local development with Socket Mode:

```bash
pnpm dev:socket
```

This reads `.env.development`, uses `SLACK_MODE=single`, and stores local state under `data/dev/`, so it can run alongside the deployed OAuth service without sharing workspace mirrors or caches.

For HTTP/OAuth debugging on a separate local port:

```bash
pnpm dev:oauth
```

Notes:

- `pnpm dev` uses Socket Mode because `NODE_ENV=development`.
- `pnpm dev:prod` uses HTTP mode because `NODE_ENV=production`.
- `pnpm dev:socket` is the recommended no-deploy loop for feature debugging.
- `pnpm dev:oauth` listens on port `3030`; expose that port with ngrok or a dev nginx route when testing OAuth install/redirect behavior.
- GitHub webhooks are only exposed in HTTP mode.

## Slack Installation Modes

CHOIR supports two Slack runtime modes:

- `SLACK_MODE=single`: one self-hosted workspace using `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET`.
- `SLACK_MODE=oauth`: one HTTP server can receive OAuth installs from multiple Slack workspaces.

OAuth mode requires:

- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_STATE_SECRET`
- `SLACK_SIGNING_SECRET`

In OAuth mode, Bolt exposes `/slack/install` and `/slack/oauth_redirect`.

Runtime state is stored in SQLite by default:

- `DATABASE_URL=file:data/choir.db`
- `CHOIR_DB_ENCRYPTION_KEY`: optional 32-byte hex key used to encrypt Slack installations and workspace config JSON. Generate one with `openssl rand -hex 32`. If omitted, CHOIR creates `data/.choir-db-key` on first encrypted write; keep that file backed up for self-hosted deployments.

Legacy JSON files under `data/*-config.json` and `data/slack-installations/` are migrated lazily the first time each workspace or installation is read.

## Scripts

- `pnpm dev`: local development in Socket Mode
- `pnpm dev:socket`: isolated Socket Mode development using `.env.development` and `data/choir-dev.db`
- `pnpm dev:oauth`: isolated OAuth/HTTP development on port `3030`
- `pnpm dev:watch`: development with `nodemon`
- `pnpm dev:prod`: HTTP-mode runtime
- `pnpm dev:web`: development with web content enhancement enabled
- `pnpm build`: compile TypeScript into `dist/`
- `pnpm test`: run unit tests
- `pnpm test:coverage`: run unit tests with coverage
- `pnpm verify`: build and run unit tests
- `pnpm lint`: run Biome on changed files only
- `pnpm lint:fix`: apply Biome fixes to changed files only
- `pnpm lint:all`: run Biome against the broader codebase backlog
- `pnpm lint:all:fix`: apply Biome fixes across the broader codebase backlog

## Linting workflow

Biome remains in the repository, but it is intentionally not part of the default verification path while the backlog is still large.

- Use `pnpm verify` for the default build-and-test path.
- Use `pnpm lint` or `pnpm lint:fix` during normal work; both target changed files only.
- Use `pnpm lint:all` only when intentionally paying down the backlog.

## GitHub webhook setup

To auto-refresh documentation after repository changes:

1. Run CHOIR in HTTP mode.
2. Expose the app at a stable public URL.
3. Add a GitHub webhook for `push` events.
4. Point the webhook to `https://your-host/webhook/github`.
5. Set `GITHUB_WEBHOOK_SECRET` in `.env` and in the GitHub webhook configuration.

CHOIR will match the incoming repository against the workspace configuration and rebuild the vector store when the configured branch changes.

## Podman deployment

CHOIR can run as a Podman-managed container behind nginx. The container serves the landing page, Slack OAuth routes, Slack events, and health checks on port `3000`.

Required host state:

- `.env` with production Slack/OpenAI/GitHub settings
- `data/` mounted into the container at `/app/data`
- nginx proxying `https://your-domain/` to `http://127.0.0.1:3000`
- Podman binding the app port to loopback only, never `0.0.0.0`

Build and deploy on this server:

```bash
./scripts/deploy-podman.sh choir.cs.vt.edu
```

The script builds `choir:latest`, installs a `choir.service` systemd unit, mounts `./data`, and checks `/healthz`.
It refuses non-loopback `HOST_BIND` values by default so the app port is not exposed directly to the network.

Useful commands:

```bash
sudo systemctl status choir
sudo journalctl -u choir -f
sudo systemctl restart choir
```

## Local state

CHOIR stores workspace configuration and connection state under `data/` in the project directory. That directory is runtime state and should not be treated as checked-in source.
