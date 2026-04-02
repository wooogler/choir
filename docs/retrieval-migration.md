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
