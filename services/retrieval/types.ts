import type { Document } from '@langchain/core/documents';
import type { DocumentMetadata } from 'services/file-registry/types';

export type RetrievalProviderName = 'qmd';

export interface RetrievalSearchParams {
  query: string;
  limit?: number;
  workspaceId?: string;
}

export interface RetrievalWarmupParams {
  workspaceId: string;
  query?: string;
}

export type RetrievalDocument = Document<DocumentMetadata>;

export interface RetrievalProvider {
  readonly name: RetrievalProviderName;
  search(params: RetrievalSearchParams): Promise<RetrievalDocument[]>;
  warmup?(params: RetrievalWarmupParams): Promise<void>;
  isHealthy?(): Promise<boolean> | boolean;
}
