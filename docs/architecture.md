# Architecture

CHOIR is a Slack Bolt app organized around Slack entrypoints, feature handlers, and service modules.

## Top-Level Layout

- `app.ts`: process bootstrap, Slack app setup, HTTP routes, and listener registration.
- `listeners/`: Slack events, actions, shortcuts, and view submissions.
- `services/`: business logic for GitHub, Slack, retrieval, document editing, workspace state, and persistence.
- `src/`: shared configuration, constants, utility exports, and cross-cutting types.
- `public/`: static landing page assets served by the HTTP app.
- `scripts/`: operational scripts that run through `ts-node` or shell.
- `python/`: standalone document conversion utilities.
- `docs/`: maintainer-facing design notes.
- `deployment/`: container and nginx deployment assets.
- `__tests__/`: Jest unit tests.

Runtime output is intentionally outside source control:

- `dist/`: TypeScript build output.
- `data/`: SQLite databases, workspace mirrors, caches, and logs.
- `coverage/`: Jest coverage reports.

## Listener Organization

`listeners/index.ts` registers two kinds of modules:

- `listeners/event-handlers/`: top-level Slack events such as app home opens, mentions, DMs, modal closes, and uninstall events.
- `listeners/features/`: feature-level action and view registrations.

Feature folders should expose a small `index.ts` that registers their callbacks. Large flows should live in focused subfolders:

- `app-home/`: the Home tab's four tabs (Home / Documents / Team / Advanced); see [app-home.md](app-home.md) for the layout rules and who sees what.
- `app-home/management/`: manager, CHOIR user, logging, and read-only file controls.
- `document-update/actions/`: small Slack actions that support document updates.
- `document-update/apply-document/`: applying accepted updates and new sections.
- `document-update/extract-knowledge/`: extracting update candidates from Slack conversations.
- `document-update/suggestions/`: manager review and suggestion flow.

## Service Organization

Service modules should not depend on Slack payload shapes unless they are explicitly Slack-facing. The intended split is:

- `services/slack/`: Slack API helpers, installation storage, channel/user utilities, and Slack-specific formatting.
- `services/github/`: repository access, OAuth/device flow, commits, file operations, and webhook handling.
- `services/document/`: markdown parsing, tree operations, update anchors, section utilities, and document update state.
- `services/retrieval/` and `services/file-registry/`: document indexing and retrieval providers.
- `services/llm/`: model calls, prompts, response generation, and content generation.
- `services/import/`: bringing outside documents in as new markdown files — `sources/web` (URL → Readability → markdown), `sources/pdf` (pdfjs inspection + Responses API transcription), the draft store, source note, commit guard, and the `/api/docs/:workspaceId/import/*` routes (see [pdf-web-import.md](pdf-web-import.md)).
- `services/google/`: Google Drive/Docs replica sync, review cards, and the Google Docs import.
- `services/workspace/`: persisted workspace configuration, runtime mirrors, and cleanup.
- `services/common/`: logging, sessions, timestamps, names, data paths, and shared error helpers.
- `services/i18n/`: locale resolution, the Bolt locale middleware, and per-reader translators; catalogs live in `src/i18n/` (see [i18n.md](i18n.md)).

When adding a feature, prefer a thin listener that validates Slack payloads and delegates domain work to a service. When a listener grows beyond one clear Slack interaction, split it by action, view, or flow step.
