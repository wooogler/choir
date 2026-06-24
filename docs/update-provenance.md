# Update Provenance (commit-attached context)

Status: design, unimplemented as of 2026-06-24.

## Goal

Every document change CHOIR makes should carry a machine-readable record of **why**
it happened: the Slack conversation that drove it (utterances + speakers), the
extracted knowledge, and which manager applied it. The docs viewer surfaces this
per file as a history timeline — each entry shows the diff alongside the
conversation and knowledge that produced it.

Covered change types:

- `update`  — an existing node/section was edited from extracted knowledge.
- `append`  — content appended to a section.
- `new-file` — a new markdown file created from a conversation.
- `web-edit` — a manual edit saved from the docs viewer/editor (no conversation;
  manager + diff only).

## Storage decision

Context is stored as an **encrypted sidecar file committed in the same commit as
the document change**, under a hidden `.choir/context/` folder. Decided over the
alternatives:

- **Not the commit message.** The message is git's single human-facing field;
  filling it with an encrypted blob destroys `git log` / GitHub / blame
  readability, is size-bounded, frozen (no later enrichment without history
  rewrite), and forces N+1 API parsing to list a file's history. (The legacy
  `CommitInfo` path in `services/github/commit-manager.ts` — JSON-in-message — is
  superseded by this and can be retired.)
- **Not a separate branch.** Overkill here: CHOIR commits directly to the docs
  branch (no PR/CI gate), and a same-commit file in a hidden folder does not
  pollute `git log -- <doc>` (path-filtered) anyway.
- **Same commit, encrypted file.** 1 commit = 1 change + its provenance; they can
  never drift; clone/backup carries both. Raw conversation is never readable on
  GitHub (encryption). Cost: the write path must move from the Contents API
  (one file per commit) to the Git Data API (multi-file commit) — see below.

GitHub is used here as the durable store ("GitHub as cloud"); the local mirror is
not authoritative for context.

## On-disk layout

```
.choir/context/<doc-path>/<unixMs>-<rand8>.json.enc
# e.g. .choir/context/docs/policy.md/1719240000000-a1b2c3d4.json.enc
```

- Mirror the document path so the viewer lists one folder to get a file's history.
- Filename cannot embed the doc commit SHA (the file *is* part of that commit —
  chicken-and-egg). Use `unixMs` (sort key) + random suffix. The owning commit is
  whatever commit introduced the file; the record stores `before`/`after`, not its
  own SHA.

## Record schema (plaintext, pre-encryption)

```jsonc
{
  "version": 1,
  "type": "update" | "append" | "new-file" | "web-edit",
  "file": { "path": "docs/policy.md", "name": "policy.md" },
  "createdAt": "2026-06-24T12:00:00.000Z",
  "updatedBy": { "userId": "U…", "name": "이상원" },
  "source": { "channelId": "C…", "threadTs": "…", "permalink": "…" }, // omit for web-edit
  "knowledge": "연차 휴가는 연간 20일이다.",                            // "" for web-edit
  "messages": [                                                       // [] for web-edit
    { "userId": "U…", "username": "이상원", "text": "연차를 20일로 바꾸자", "ts": "…" }
  ],
  "diff": { "section": "<headingPath?>", "nodeId": "<id?>", "before": "…", "after": "…" },
  "nodeIds": ["…"]
}
```

Per type:
- `new-file`: `diff.before = ""`, `diff.after =` full file; `knowledge`/`messages`
  from the originating suggestion.
- `web-edit`: `messages = []`, `knowledge = ""`, `updatedBy =` the web-session
  manager, `diff.before/after =` previous vs saved content.

Conversation is stored **as-is** (already consent-filtered upstream: non-CHOIR
users are excluded at gather time).

## Encryption

Reuses the existing AES-256-GCM construction in `services/db/crypto.ts` (envelope
string `v1:<iv b64>:<tag b64>:<ct b64>`), parameterized by an explicit key:

- Add `encryptStringWithKey(value, key)` / `decryptStringWithKey(value, key)` to
  `services/db/crypto.ts`; the existing global-key helpers delegate to them.
- The `.json.enc` file body = `encryptStringWithKey(JSON.stringify(record), wsKey)`.
- **Per-workspace key** `wsKey` (random 32B) is stored in `WorkspaceConfig` (see
  Key management) — and `WorkspaceConfig` is already encrypted-at-rest by the DB
  master key (`CHOIR_DB_ENCRYPTION_KEY`). So GitHub holds only ciphertext; the
  per-workspace key lives only in the app DB, itself encrypted. **No HKDF** — the
  stored key is the key.
- **Decryption is server-side only.** The viewer API decrypts and serves plaintext
  over the authenticated manager session; the browser never sees the key.

## Key management (App Home)

Managed from App Home, mirroring the existing per-workspace OpenAI-key settings
(`listeners/features/app-home/management/openai-settings-handlers.ts`). Stored as
`WorkspaceConfig.contextEncryption?: { key, algorithm: 'aes-256-gcm', createdAt,
rotatedAt }`.

- **First use:** auto-generated (`crypto.randomBytes(32)`) on the first context
  write — no friction. `WorkspaceStore.getOrCreateContextKey(workspaceId)`.
- **Home status:** shows created/rotated timestamps; never prints the raw key
  inline.
- **Rotate / replace = deliberately hard** (per request). Rotating orphans every
  previously-encrypted record (old key gone), so gate it behind:
  1. a warning modal spelling out that all existing provenance becomes permanently
     unreadable;
  2. type-to-confirm a phrase (e.g. the org/workspace name);
  3. a second "정말로?" confirm before applying.
- **Backup / restore:** export the current key and import one (so a DB loss does
  not orphan history, and a custom key can be supplied) — also behind a confirm.
  Import doubles as "bring your own key."

Resolved: per-workspace **stored** key (not master-env + HKDF).

## Write path — Git Data API helper

All three sites currently write via the Contents API
(`createOrUpdateFileContents`, one file/commit). Add one helper and route them
through it:

```
GithubService.commitFilesWithContext({
  owner, repo, branch, message,
  files: [{ path, content }],        // the doc change(s)
  context?: { path, ciphertext },    // the .json.enc sidecar
  workspaceId, userId,
}) -> { commitSha }
```

Implementation: `getRef(HEAD)` → `getCommit(base)` → `createBlob` per file →
`createTree(base_tree)` → `createCommit(parent = HEAD)` → `updateRef` (retry on
non-fast-forward, mirroring today's stale-SHA retry).

Call sites:
- `services/github/document-updater.ts` (`applyDocumentUpdatesToGithub`) — has
  `allMessages`, `knowledgeContent`, `userId`, `nodeIds`, per-update
  `oldContent/newContent`.
- `listeners/.../create-file-submission.ts` — thread the originating
  messages + knowledge into the `CREATE_FILE_MODAL` session (today it only carries
  `knowledgeSource{ChannelId,ThreadTs}` + default content), and have the helper
  return `commitSha`.
- `services/docs-editor/save-document.ts` (`saveEditedDocument`) — `web-edit`
  record; build `before` from the pre-save mirror content.

## Read path — viewer API

**Workspace-member-gated**: any signed-in member sees full records (conversation
included) — CHOIR exists to share workspace knowledge, so the boundary is
internal-vs-external, not the `choirUsers` subset. A valid session now *proves*
membership: the sign-in callback verifies the OIDC `team_id` claim equals
`workspaceId` (which IS the Slack team_id), so external visitors get no valid
session → blocked (401 no session / 403 team mismatch at sign-in). Gate =
`readSession` + workspace match. Docs *content* routes intentionally stay PUBLIC
(per decision) — only provenance is gated. `/api/docs/session` also returns
`isChoirUser` / `isManager` for finer UI affordances.

- `GET /api/docs/:workspaceId/provenance/*splat`
  → list decrypted **summaries** for the file (type, updatedBy, createdAt,
  hasConversation), newest first.
- `GET /api/docs/:workspaceId/provenance/*splat?id=<file>`
  → one fully decrypted record (diff + messages + knowledge).

Ciphertext source: extend `GitHubSyncService` / `WorkspaceMirrorService` to also
sync `.choir/context/**` (today markdown-only). The viewer API reads the
`.json.enc` from the **local mirror** and decrypts server-side. Resolved: mirror
sync (not GitHub API on-demand).

## Viewer UI

`web/src/components/DocViewer.tsx`: add a **"변경 이력 / History"** panel (shown to
signed-in members; gate on `session.authenticated`). Doc viewing itself stays
public; only this panel requires sign-in. Timeline → expand an entry to show:
- the diff (render stored `before`/`after`),
- the conversation as speaker bubbles (username + text + time),
- the extracted knowledge,
- a header with manager, timestamp, and a type badge.

## Resolved decisions

1. Key source: **per-workspace stored key** in `WorkspaceConfig`, managed from App
   Home with heavy confirmation on rotate/replace.
2. Read transport: **extend mirror sync** to pull `.choir/context/`; viewer reads
   locally.
3. Legacy `CommitInfo` / `getHistoryOfMarkdownUpdate` JSON-in-message path: **retire**
   (check callers in `services/github/commit-manager.ts` consumers first).

## Build order

1. **Foundation** — `encrypt/decryptStringWithKey` in `services/db/crypto.ts`;
   `WorkspaceConfig.contextEncryption` + `WorkspaceStore.getOrCreateContextKey` /
   `rotateContextKey` / `getContextKeyStatus`; `GithubService.commitFilesWithContext`
   (Git Data API). Decision-stable, unit-testable.
2. **Record + wiring** — provenance record type + builder; route the 3 write sites
   through the helper (update/append → new-file → web-edit).
3. **Mirror sync** — pull `.choir/context/**` into the mirror.
4. **Read API** — manager-gated list + single-record endpoints, server-side decrypt.
5. **Viewer panel** — history timeline with diff + conversation + knowledge.
6. **Home key management** — status + rotate/backup with confirmation friction.
7. **Retire legacy** — remove JSON-in-message path once viewer covers history.
