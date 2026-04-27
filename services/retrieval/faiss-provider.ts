import { Logger } from 'services/common/logger';
import { VectorStoreService } from 'services/vector/main-service';
import type { RetrievalDocument, RetrievalProvider, RetrievalSearchParams, RetrievalWarmupParams } from './types';

export class FaissRetrievalProvider implements RetrievalProvider {
  public readonly name = 'faiss' as const;

  async search(params: RetrievalSearchParams): Promise<RetrievalDocument[]> {
    const vectorStore = VectorStoreService.getInstance();
    const limit = params.limit ?? 5;

    Logger.info(
      `FaissRetrievalProvider: searching for "${params.query.substring(0, 50)}${params.query.length > 50 ? '...' : ''}" with limit=${limit}`,
      {
        workspaceId: params.workspaceId,
      },
    );
    return await vectorStore.similaritySearch(params.query, limit, params.workspaceId);
  }

  async warmup(_params: RetrievalWarmupParams): Promise<void> {
    Logger.info('FaissRetrievalProvider: no warm-up needed.');
  }

  isHealthy(workspaceId?: string): boolean {
    return VectorStoreService.getInstance().isHealthy(workspaceId);
  }
}
