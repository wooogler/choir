# Retrieval Migration Notes

## Current State

CHOIR currently uses GitHub as the document source of truth and builds a local FAISS index for retrieval.

Current runtime flow:

1. Workspace stores GitHub repository metadata only.
2. App startup loads markdown files from cache when possible.
3. If cache is missing or stale, the app fetches markdown files from GitHub APIs.
4. Documents are chunked, embedded with OpenAI, and indexed into FAISS.
5. Question answering retrieves top matches from FAISS and sends them to the LLM as references.

This means retrieval quality and indexing are tightly coupled to:

- GitHub API reads
- OpenAI embedding calls
- FAISS-specific storage and update paths

## Migration Goal

Move toward a split architecture:

- GitHub remains the authoritative remote source
- A local workspace mirror becomes the operational source for indexing
- Retrieval engine becomes pluggable
- Search backend can evolve from FAISS to QMD without rewriting question-answering logic

## Proposed Target Architecture

### Source of Truth

- Remote authoritative source: GitHub repository
- Local operational source: workspace mirror on disk
- Retrieval index source: local mirror files

### Sync Model

1. Initial sync
   - Fetch repository contents from GitHub into a workspace mirror directory.
   - Persist sync metadata locally.
2. Retrieval indexing
   - Build retrieval index from local mirror files.
   - Keep backend-specific data separate from mirror content.
3. Local edit flow
   - Apply change to local mirror first.
   - Update retrieval index locally.
   - Push change back to GitHub.
   - Mark sync state clean only after GitHub write succeeds.
4. Remote update flow
   - GitHub webhook or manual refresh pulls remote changes.
   - Local mirror is refreshed.
   - Retrieval index is rebuilt or incrementally updated.

## Suggested Workspace Layout

Example under `data/workspaces/<workspaceId>/`:

```text
repo/
  docs/
  handbook/
state/
  workspace.json
  sync-state.json
retrieval/
  faiss/
  qmd/
cache/
  web-content/
logs/
```

Notes:

- `repo/` is the canonical local mirror used for indexing.
- `retrieval/faiss/` and `retrieval/qmd/` should be backend-specific and disposable.
- `state/sync-state.json` can track branch, last synced commit, dirty files, and pending operations.

## Migration Phases

### Phase 1

- Introduce `RetrievalProvider` abstraction.
- Keep FAISS as the active backend.
- Route question retrieval through the abstraction.

### Phase 2

- Introduce workspace local mirror abstraction.
- Stop treating GitHub API responses as the primary in-memory document source.
- Rebuild FAISS from mirror files to validate the mirror model.

### Phase 3

- Add `QmdProvider`.
- Run FAISS and QMD in shadow mode for side-by-side result comparison.
- Compare relevance, latency, and operational overhead.

### Phase 4

- Switch primary retrieval backend when quality and operations are acceptable.
- Keep FAISS fallback until migration is proven stable.

## Why QMD Is Interesting

QMD is appealing because it combines:

- lexical search
- vector search
- reranking
- SQLite-backed local storage

That is a better long-term fit for a local mirror workflow than the current FAISS-only path.

## Immediate Next Steps

1. Keep retrieval calls behind `RetrievalProvider`.
2. Add `SyncProvider` or `WorkspaceMirrorService` abstraction next.
3. Introduce local mirror path management per workspace.
4. Define dirty-state and conflict semantics before changing write flows.

## Switching the Embedding Model

The vector leg of hybrid search is embedded by whatever model
`QMD_EMBED_MODEL` names — QMD reads it at module import, `createStore` has no
per-store option, and the `model` column it writes next to each vector is a
label nothing ever compares. So a swapped model used to be invisible: the old
768-d vectors stayed in `content_vectors`, re-embedding skipped them (it only
visits chunks with *no* vector), and the first query threw a dimension
mismatch inside `vectors_vec MATCH` that was swallowed into a silent
lexical-only fallback.

CHOIR therefore keeps a sidecar next to each index:

```
<workspace>/state/qmd-index-v2.sqlite
<workspace>/state/qmd-index-v2.meta.json   { "embedModel": "...", "embeddedAt": "..." }
```

`services/retrieval/qmd-embed-guard.ts` compares it with the configured model
on every store init. Missing sidecar → written with the current value (the
existing index is assumed to match; this is the first-deploy case). Match →
nothing. Mismatch → a warning, then `syncStoreIndex(store, true)` (a forced
full re-embed) *before* the store serves a single query, then the sidecar is
rewritten. If that re-embed fails the sidecar is deliberately left stale so
the next start retries.

### Runbook

1. Decide the CPU budget first. The default is
   `embeddinggemma-300M-Q8_0` (768-d). `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`
   (1024-d) is stronger cross-lingually but roughly doubles embed and query
   cost, and production runs six CPU-only PM2 instances.
2. Set `QMD_EMBED_MODEL` in the instance's env file.
3. Restart the instance. The guard runs the forced re-embed on the first store
   init per workspace — the first question after a restart waits for it.
   To do it on demand instead, use App Home → *Rebuild index*, which wipes the
   sqlite file, re-embeds and writes the sidecar itself.
4. Expect roughly a minute per few hundred section files on CPU; a mid-size
   workspace lands in the tens of minutes. The process looks idle while
   llama.cpp works.

### Verifying

- `cat <workspace>/state/qmd-index-v2.meta.json` shows the new `embedModel`
  and a fresh `embeddedAt`.
- The logs show `QMD_EMBED_MODEL changed since this index was embedded`
  followed by `re-embedded the QMD index for the new embedding model`, and the
  store-init line reports `embedGuardOutcome: "re-embedded"`.
- No `hybrid search failed` errors afterwards; `vectorSearchFailures` stays at
  its previous count in the init/warm-up lines.

### Rolling Back

Put the previous `QMD_EMBED_MODEL` value back (or unset it) and restart: the
sidecar now disagrees in the other direction, so the guard re-embeds back to
the old model on its own. Nothing outside `state/` is touched, and deleting
`qmd-index-v2.sqlite*` plus `qmd-index-v2.meta.json` always rebuilds from the
mirror from scratch.
