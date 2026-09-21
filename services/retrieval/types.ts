import type { Document } from '@langchain/core/documents';
import type { DocumentMetadata } from 'services/file-registry/types';

export type RetrievalProviderName = 'qmd';

/**
 * Narrowing a search to a project folder (docs/project-folders.md 3).
 *
 * QMD keeps one `docs` collection per workspace and offers no path filter, so
 * the scope is applied after the fact: the provider over-fetches and
 * `applyRetrievalScope` re-orders (`boost`) or filters (`exclusive`) the
 * results by `metadata.fileName`. A per-project collection is the next step if
 * the over-fetch ever becomes the bottleneck, not the starting point.
 */
export interface RetrievalScope {
  /** Folder paths, each with a trailing slash — `projects/alpha/`. */
  pathPrefixes: string[];
  mode: 'boost' | 'exclusive';
  /**
   * `exclusive` only: keep repository-root documents too. The README, the root
   * glossary and the organization's rules are evidence in every project.
   */
  includeRootFiles?: boolean;
}

export interface RetrievalSearchParams {
  query: string;
  limit?: number;
  workspaceId?: string;
  scope?: RetrievalScope;
}

export interface RetrievalWarmupParams {
  workspaceId: string;
  query?: string;
}

export type RetrievalDocument = Document<DocumentMetadata>;

/**
 * What a search returns when the caller also needs to know how it went.
 *
 * `search` stays the plain array it has always been — every caller but the
 * question path only wants documents — and `searchWithMeta` is the opt-in
 * side channel for the one fact that cannot be read off the documents:
 * whether an `exclusive` scope found nothing and was widened to the workspace.
 */
export interface RetrievalSearchResult {
  documents: RetrievalDocument[];
  widened: boolean;
}

export interface RetrievalProvider {
  readonly name: RetrievalProviderName;
  search(params: RetrievalSearchParams): Promise<RetrievalDocument[]>;
  searchWithMeta?(params: RetrievalSearchParams): Promise<RetrievalSearchResult>;
  warmup?(params: RetrievalWarmupParams): Promise<void>;
  isHealthy?(): Promise<boolean> | boolean;
}
