import { AzureOpenAIEmbeddings } from '@langchain/azure-openai';
import type { Document } from '@langchain/core/documents';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { ErrorCodes } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import type { EmbeddingService } from './embedding-service';
import { EnhancedSearchService } from './enhanced-search';
import { SearchService } from './search-service';
import { type DocumentMetadata, VectorStoreError } from './types';

export class VectorStoreManager {
  private store: MemoryVectorStore | null = null;
  private isInitialized = false;
  private documents: Document<DocumentMetadata>[] = [];
  private embeddingService: EmbeddingService;
  private searchService: SearchService | null = null;
  private enhancedSearchService: EnhancedSearchService | null = null;

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
  }

  async initializeStore(documents: Document<DocumentMetadata>[], embeddings: number[][]): Promise<boolean> {
    try {
      this.documents = documents;

      if (documents.length === 0) {
        Logger.warn('Initializing empty vector store');
        const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
        this.store = new MemoryVectorStore(openAIEmbeddings);
        this.searchService = new SearchService(this.store, this.embeddingService);
        this.searchService.buildSearchIndices(this.documents);
        this.enhancedSearchService = new EnhancedSearchService(this as any);
        this.isInitialized = true;
        return true;
      }

      const azureOpenAIEmbeddings = this.embeddingService.getEmbeddingAPI();
      this.store = new MemoryVectorStore(azureOpenAIEmbeddings);

      const success = await this.embeddingService.loadEmbeddingsToVectorStore(this.store, this.documents, embeddings);

      if (!success) {
        Logger.error('Failed to load embeddings to vector store');
        return false;
      }

      this.searchService = new SearchService(this.store, this.embeddingService);
      this.searchService.buildSearchIndices(this.documents);
      this.enhancedSearchService = new EnhancedSearchService(this as any);

      this.isInitialized = true;
      Logger.info(`Vector store initialized with ${this.documents.length} documents`);
      return true;
    } catch (error) {
      Logger.error('Error initializing vector store', error as Error);
      return false;
    }
  }

  async rebuildStore(documents: Document<DocumentMetadata>[], embeddings: number[][]): Promise<boolean> {
    try {
      Logger.info('Rebuilding vector store');
      this.reset();
      return await this.initializeStore(documents, embeddings);
    } catch (error) {
      Logger.error('Error rebuilding vector store', error as Error);
      return false;
    }
  }

  reset(): void {
    this.isInitialized = false;
    this.store = null;
    this.documents = [];
    this.searchService = null;
    this.enhancedSearchService = null;
  }

  checkInitialized(): void {
    if (!this.isInitialized || !this.store || !this.searchService) {
      throw new VectorStoreError('Vector store is not initialized', {
        code: ErrorCodes.VECTOR_STORE_NOT_INITIALIZED,
      });
    }
  }

  getStore(): MemoryVectorStore | null {
    return this.store;
  }

  getDocuments(): Document<DocumentMetadata>[] {
    return this.documents;
  }

  getSearchService(): SearchService | null {
    return this.searchService;
  }

  getEnhancedSearchService(): EnhancedSearchService | null {
    return this.enhancedSearchService;
  }

  isStoreInitialized(): boolean {
    return this.isInitialized;
  }

  getDiagnostics() {
    try {
      if (!this.isInitialized || !this.store) {
        return {
          status: 'error' as const,
          details: {
            isInitialized: false,
            documentCount: 0,
            vectorsCount: 0,
            searchIndices: {
              documentsByNodeId: 0,
              documentsBySectionId: 0,
              sectionSummaries: 0,
              entitiesCount: 0,
            },
          },
        };
      }

      const memoryVectors = (this.store as any).memoryVectors;
      const vectorsCount = Array.isArray(memoryVectors) ? memoryVectors.length : 0;
      const searchIndices = this.searchService?.getDiagnostics() || {
        documentsByNodeId: 0,
        documentsBySectionId: 0,
        sectionSummaries: 0,
        entitiesCount: 0,
      };

      let status: 'healthy' | 'degraded' | 'error' = 'healthy';

      if (vectorsCount === 0 || this.documents.length === 0) {
        status = 'error';
      } else if (vectorsCount < this.documents.length * 0.9) {
        status = 'degraded';
      }

      return {
        status,
        details: {
          isInitialized: this.isInitialized,
          documentCount: this.documents.length,
          vectorsCount,
          searchIndices,
        },
      };
    } catch (error) {
      Logger.error('Error diagnosing vector store', error as Error);
      return {
        status: 'error' as const,
        details: {
          isInitialized: false,
          documentCount: 0,
          vectorsCount: 0,
          searchIndices: {
            documentsByNodeId: 0,
            documentsBySectionId: 0,
            sectionSummaries: 0,
            entitiesCount: 0,
          },
        },
      };
    }
  }
}
