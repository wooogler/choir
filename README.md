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

- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `MANAGER_PROMOTION_PASSWORD`
- `CHOIR_CONSENT_FORM_URL`
- `SLACK_APP_ID`

QMD question-answer retrieval can be enabled explicitly with `RETRIEVAL_PROVIDER=qmd`.
To use QMD for document-update anchoring as well, set `UPDATE_RETRIEVAL_PROVIDER=qmd`.

`env.sample` documents the full set currently used by the app.

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
pnpm dev
```

For HTTP mode:

```bash
pnpm dev:prod
```

Notes:

- `pnpm dev` uses Socket Mode because `NODE_ENV=development`.
- `pnpm dev:prod` uses HTTP mode because `NODE_ENV=production`.
- GitHub webhooks are only exposed in HTTP mode.

## Scripts

- `pnpm dev`: local development in Socket Mode
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

## Local state

CHOIR stores workspace configuration and connection state under `data/` in the project directory. That directory is runtime state and should not be treated as checked-in source.
