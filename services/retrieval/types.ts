import type { Document } from '@langchain/core/documents';
import type { DocumentMetadata } from 'services/vector/types';

export type RetrievalProviderName = 'faiss' | 'qmd';

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
