import { Logger } from 'services/common/logger';
import { QmdRetrievalProvider } from './qmd-provider';
import type { RetrievalProvider, RetrievalSearchParams, RetrievalSearchResult } from './types';

let provider: RetrievalProvider | undefined;

export function getRetrievalProvider(): RetrievalProvider {
  if (!provider) {
    Logger.info('Creating QMD retrieval provider.');
    provider = new QmdRetrievalProvider();
  }

  return provider;
}

/**
 * A search that also reports whether an `exclusive` scope had to be widened.
 *
 * `searchWithMeta` is optional on the provider interface so a provider that
 * knows nothing about scopes stays valid; this helper is what callers use so
 * they never have to check.
 */
export async function searchWithMeta(
  retrievalProvider: RetrievalProvider,
  params: RetrievalSearchParams,
): Promise<RetrievalSearchResult> {
  if (retrievalProvider.searchWithMeta) {
    return await retrievalProvider.searchWithMeta(params);
  }

  return { documents: await retrievalProvider.search(params), widened: false };
}

export {
  SCOPE_MAX_OVER_FETCH,
  SCOPE_OVER_FETCH_FACTOR,
  applyRetrievalScope,
  overFetchLimit,
  scopeForProject,
} from './scope';
export type { ScopedResults } from './scope';

export type {
  RetrievalDocument,
  RetrievalProvider,
  RetrievalProviderName,
  RetrievalScope,
  RetrievalSearchParams,
  RetrievalSearchResult,
} from './types';
