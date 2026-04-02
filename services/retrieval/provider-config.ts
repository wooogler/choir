import type { RetrievalProviderName } from './types';

export function normalizeRetrievalProviderName(name?: string): RetrievalProviderName {
  if (name === 'qmd') {
    return 'qmd';
  }

  return 'faiss';
}

export function getConfiguredRetrievalProviderName(name = process.env.RETRIEVAL_PROVIDER): RetrievalProviderName {
  return normalizeRetrievalProviderName(name);
}

export function isQmdRetrievalEnabled(name = process.env.RETRIEVAL_PROVIDER): boolean {
  return getConfiguredRetrievalProviderName(name) === 'qmd';
}
