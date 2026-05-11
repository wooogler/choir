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

## Project layout

- `app.ts`: app bootstrap and HTTP routes
- `listeners/`: Slack event, action, and view handlers
- `services/`: GitHub, Slack, retrieval, document, LLM, workspace, and persistence logic
- `src/`: shared config, constants, types, and utilities
- `public/`: static web assets
- `scripts/`: maintenance and migration scripts
- `docs/`: architecture and implementation notes
- `deployment/`: container and nginx deployment files

See [docs/architecture.md](docs/architecture.md) for a fuller map of the codebase.

## Choosing a Slack runtime mode

CHOIR supports two Slack runtime modes. Pick the one that matches your deployment intent before configuring `.env`.

- `SLACK_MODE=single` — **self-hosted, one Slack workspace.** Uses a static `SLACK_BOT_TOKEN` issued when you install your own Slack app. This is the recommended path for teams that want to run CHOIR on their own infrastructure for their own workspace.
- `SLACK_MODE=oauth` — **multi-workspace OAuth distribution.** One HTTP server accepts OAuth installs from multiple Slack workspaces and stores per-workspace credentials. Use this only if you intend to distribute your CHOIR instance to other workspaces (mirrors the hosted `choir.cs.vt.edu` deployment).

The rest of this README walks through the **self-hosted single-workspace** path. See [Multi-workspace OAuth distribution](#multi-workspace-oauth-distribution) at the bottom for the OAuth-mode specifics.

## Getting started (self-hosted, single workspace)

### 1. Install dependencies

```bash
git clone https://github.com/wooogler/choir.git
cd choir
pnpm install
```

### 2. Create your Slack app from the manifest template

1. Copy the template and replace the domain placeholder with the public hostname you will deploy CHOIR at (e.g. `choir.example.com`). For local development with Socket Mode you can leave the URLs as-is — they will not be reached.

   ```bash
   cp manifest.example.json manifest.local.json
   # then edit manifest.local.json and replace your-domain.example with your domain
   ```

2. Open <https://api.slack.com/apps/new>, choose **From an app manifest**, and paste the contents of `manifest.local.json`.
3. For local Socket Mode development, set **Socket Mode** to **on** in the Slack app settings and generate an app-level token (`xapp-...`) with `connections:write`.
4. Install the app into your workspace and copy the **Bot User OAuth Token** (`xoxb-...`) and **Signing Secret**.

### 3. Configure environment variables

```bash
cp .env.example .env
```

For a self-hosted single workspace, set at minimum:

```env
SLACK_MODE=single
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OPENAI_API_KEY=sk-...
```

Add `SLACK_APP_TOKEN=xapp-...` when running locally in Socket Mode (`pnpm dev:socket` or `pnpm dev`). It is not needed in HTTP-mode production.

Optional but commonly used:

- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` — enables managers to connect a GitHub account via device flow. Required if you want CHOIR to read your docs repo. Create a GitHub OAuth App and enable the **Device Flow** option in its settings.
- `GITHUB_WEBHOOK_SECRET` — enables automatic re-indexing on `push` events (HTTP mode only).
- `MANAGER_PROMOTION_PASSWORD` — shared secret managers enter in App Home to gain manager-only controls.
- `CHOIR_CONSENT_FORM_URL` — link shown in onboarding flows.
- `CHOIR_DB_ENCRYPTION_KEY` — optional 32-byte hex key (`openssl rand -hex 32`) used to encrypt Slack installations and workspace config JSON in SQLite. If omitted, CHOIR creates `data/.choir-db-key` on first encrypted write; back that file up alongside `data/`.

`.env.example` documents the full set of supported variables. CHOIR does not use a server-wide GitHub PAT; managers authenticate their own GitHub account via OAuth device flow.

### 4. Run the app

For local development with Socket Mode (no public URL required):

```bash
pnpm dev:socket
```

This reads `.env.development`, forces `SLACK_MODE=single`, and isolates state under `data/dev/`, so it does not clash with a production deployment.

Notes:

- `pnpm dev` also uses Socket Mode because `NODE_ENV=development`.
- `pnpm dev:prod` runs in HTTP mode locally (useful for testing webhook handlers).
- `pnpm dev:oauth` listens on port `3030` in OAuth mode for OAuth-flow debugging.
- GitHub webhooks are only available in HTTP mode.

## Production deployment (self-hosted single workspace)

For production, run CHOIR in HTTP mode behind a reverse proxy on a public hostname. The repository includes a Podman + systemd + nginx reference setup.

### Server prerequisites

- Linux host with `podman`, `pnpm`, `nginx`, and a valid TLS certificate (e.g. Let's Encrypt) for your domain
- DNS `A`/`AAAA` record pointing your domain at the host

### One-time setup

1. Copy `.env.example` to `.env` on the server and fill in the values above with `SLACK_MODE=single` and `NODE_ENV=production`. Make sure the Slack app's event/interactivity request URLs in your manifest match `https://your-domain/slack/events`.
2. Adapt the nginx config. The shipped `deployment/nginx.conf` reflects the maintainer's multi-workspace production setup and is not suitable as-is. Start from the minimal example instead:

   ```bash
   sudo cp deployment/nginx.example.conf /etc/nginx/sites-available/choir
   sudo ln -s /etc/nginx/sites-available/choir /etc/nginx/sites-enabled/choir
   # edit the file and replace your-domain.example with your hostname
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. Deploy with the helper script, passing your domain as the first argument:

   ```bash
   ./scripts/deploy-podman.sh your-domain.example
   ```

   The script builds `choir:latest`, installs a `choir.service` systemd unit, mounts `./data` into the container, binds the app to `127.0.0.1:3000`, and waits on `/healthz`. It refuses non-loopback `HOST_BIND` values by default so the app port is not exposed directly to the network.

### Useful commands

```bash
sudo systemctl status choir
sudo journalctl -u choir -f
sudo systemctl restart choir
```

### GitHub webhook setup (optional)

To auto-refresh documentation after repository changes:

1. Add a GitHub webhook to your docs repository for `push` events.
2. Point the webhook at `https://your-domain/webhook/github`.
3. Set `GITHUB_WEBHOOK_SECRET` in both `.env` and the GitHub webhook configuration.

CHOIR will match the incoming repository against the workspace's saved repo configuration and rebuild the vector store when the configured branch changes.

## Local state

CHOIR stores workspace configuration, repository mirrors, vector stores, and SQLite databases under `data/` in the project directory (or `CHOIR_DATA_DIR` if set). That directory is runtime state and should not be committed.

Runtime state is stored in SQLite by default:

- `DATABASE_URL=file:data/choir.db`
- Legacy JSON files under `data/*-config.json` and `data/slack-installations/` are migrated lazily on first read.

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
- `pnpm lint` / `pnpm lint:fix`: Biome on changed files
- `pnpm lint:all` / `pnpm lint:all:fix`: Biome across the broader codebase backlog

## Linting workflow

Biome is in the repository but is intentionally not part of the default verification path while the backlog is still large.

- Use `pnpm verify` for the default build-and-test path.
- Use `pnpm lint` or `pnpm lint:fix` during normal work; both target changed files only.
- Use `pnpm lint:all` only when intentionally paying down the backlog.

## Retrieval providers

- `RETRIEVAL_PROVIDER=faiss` (default) — in-process FAISS index for question answering.
- `RETRIEVAL_PROVIDER=qmd` — local QMD retriever, useful when you want to avoid OpenAI embedding calls.
- `UPDATE_RETRIEVAL_PROVIDER=qmd` — also use QMD for document-update anchoring.

QMD is configured to run CPU-only by default (`QMD_FORCE_CPU_ONLY=true`, `NODE_LLAMA_CPP_GPU=off`).

## Multi-workspace OAuth distribution

If you want one CHOIR instance to serve OAuth installs from multiple Slack workspaces (the hosted `choir.cs.vt.edu` model), set `SLACK_MODE=oauth` and additionally configure:

- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_STATE_SECRET`
- `SLACK_REDIRECT_URI=https://your-domain/slack/oauth_redirect`
- `SLACK_SCOPES` (optional override; defaults match the manifest)

In OAuth mode, Bolt exposes `/slack/install` and `/slack/oauth_redirect`. Each installing workspace stores its own bot token in the SQLite installation store. The GitHub webhook endpoint is reachable but auto-reload is not yet wired up for OAuth installs.

Slack manifest scopes are the same as for single mode; what changes is the install path and the per-workspace token storage.
