import { Logger } from 'services/common/logger';
import { QmdRetrievalProvider } from './qmd-provider';
import type { RetrievalProvider } from './types';

let provider: RetrievalProvider | undefined;

export function getRetrievalProvider(): RetrievalProvider {
  if (!provider) {
    Logger.info('Creating QMD retrieval provider.');
    provider = new QmdRetrievalProvider();
  }

  return provider;
}

export type {
  RetrievalDocument,
  RetrievalProvider,
  RetrievalProviderName,
  RetrievalSearchParams,
} from './types';
