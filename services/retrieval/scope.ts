/**
 * Applying a project's search scope to results that were fetched without one.
 *
 * Pure on purpose: this is the whole of the `boost` / `exclusive` behaviour
 * from docs/project-folders.md 3, and it should be readable and testable
 * without a QMD index, a mirror or a workspace behind it.
 *
 * The scope is a post-filter rather than a query filter because QMD has one
 * `docs` collection per workspace and no path predicate. The provider therefore
 * asks for more than it needs (`overFetchLimit`) and hands the surplus here.
 */

import type { ProjectRecord } from 'services/projects/project-index';
import type { RetrievalDocument, RetrievalScope } from './types';

/**
 * How much more than `limit` a scoped search fetches.
 *
 * Four is the number in the design: with `boost` it gives the re-ordering
 * something to promote, and with `exclusive` it is the difference between "the
 * project has no answer" and "the project's answer was ranked sixth".
 */
export const SCOPE_OVER_FETCH_FACTOR = 4;

/**
 * Ceiling on the over-fetch. Each extra result is a chunk QMD has to score and
 * (in hybrid mode) rerank, so an unbounded multiple would make a large `limit`
 * pay for a filter that is usually satisfied by the first page anyway.
 */
export const SCOPE_MAX_OVER_FETCH = 50;

export interface ScopedResults {
  results: RetrievalDocument[];
  /**
   * An `exclusive` scope matched nothing, so these are the workspace-wide
   * results. The answer says so in a sentence; see `qa.scope.widened`.
   */
  widened: boolean;
}

/** How many results a scoped search should ask the index for. */
export function overFetchLimit(limit: number): number {
  return Math.min(Math.max(limit, 1) * SCOPE_OVER_FETCH_FACTOR, SCOPE_MAX_OVER_FETCH);
}

/**
 * The scope a project's settings ask for, or null when it asks for none.
 *
 * `off` is null rather than an empty scope so the caller can skip the
 * over-fetch entirely: "no scope" and "a scope that changes nothing" should not
 * cost the same.
 */
export function scopeForProject(project: ProjectRecord): RetrievalScope | null {
  const mode = project.settings.scope.retrieval;
  if (mode === 'off') return null;

  return {
    pathPrefixes: [`${project.folder}/`],
    mode,
    // Open question 1 in docs/project-folders.md, answered "include": the
    // README and the root glossary ground an answer in any project.
    includeRootFiles: true,
  };
}

export function applyRetrievalScope(results: RetrievalDocument[], scope: RetrievalScope, limit: number): ScopedResults {
  const prefixes = scope.pathPrefixes.map(normalizePrefix).filter((prefix) => prefix.length > 0);

  if (scope.mode === 'boost') {
    // Stable partition, not a sort: the index's own ranking is the tie-breaker
    // within each half, and a comparator over floating-point scores would lose
    // it. "Boost" here means "these come first", nothing subtler.
    const inScope = results.filter((doc) => underPrefix(doc, prefixes));
    const rest = results.filter((doc) => !underPrefix(doc, prefixes));
    return { results: [...inScope, ...rest].slice(0, limit), widened: false };
  }

  const kept = results.filter(
    (doc) => underPrefix(doc, prefixes) || (scope.includeRootFiles === true && isRootFile(doc)),
  );
  if (kept.length === 0) {
    return { results: results.slice(0, limit), widened: true };
  }

  return { results: kept.slice(0, limit), widened: false };
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function pathOf(doc: RetrievalDocument): string {
  return (doc.metadata?.fileName ?? '').replace(/^\/+/, '');
}

function underPrefix(doc: RetrievalDocument, prefixes: string[]): boolean {
  const filePath = pathOf(doc);
  if (!filePath) return false;
  return prefixes.some((prefix) => filePath.startsWith(prefix));
}

/** A document at depth 0 — `README.md`, not `projects/alpha/README.md`. */
function isRootFile(doc: RetrievalDocument): boolean {
  const filePath = pathOf(doc);
  return filePath.length > 0 && !filePath.includes('/');
}
