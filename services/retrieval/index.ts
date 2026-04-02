import { Logger } from 'services/common/logger';
import { FaissRetrievalProvider } from './faiss-provider';
import { normalizeRetrievalProviderName } from './provider-config';
import { QmdRetrievalProvider } from './qmd-provider';
import type { RetrievalProvider, RetrievalProviderName } from './types';

let provider: RetrievalProvider | undefined;

function createProvider(name: RetrievalProviderName): RetrievalProvider {
  if (name === 'qmd') {
    Logger.info('Creating QMD retrieval provider in compatibility mode.');
    return new QmdRetrievalProvider();
  }

  return new FaissRetrievalProvider();
}

export function getRetrievalProvider(name?: RetrievalProviderName): RetrievalProvider {
  const providerName = name || normalizeRetrievalProviderName(process.env.RETRIEVAL_PROVIDER);

  if (!provider || provider.name !== providerName) {
    provider = createProvider(providerName);
  }

  return provider;
}

export type {
  RetrievalDocument,
  RetrievalProvider,
  RetrievalProviderName,
  RetrievalSearchParams,
} from './types';
