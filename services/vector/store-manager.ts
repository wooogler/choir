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

  // ===== 증분 업데이트 메서드들 =====

  /**
   * 벡터 스토어에 새로운 문서들을 추가
   */
  async addDocuments(documents: Document<DocumentMetadata>[], embeddings: number[][]): Promise<boolean> {
    try {
      if (!this.isInitialized || !this.store) {
        Logger.error('Vector store not initialized');
        return false;
      }

      if (documents.length !== embeddings.length) {
        Logger.error('Documents and embeddings length mismatch');
        return false;
      }

      if (documents.length === 0) {
        Logger.info('No documents to add');
        return true;
      }

      // MemoryVectorStore에 문서 추가
      await this.store.addVectors(embeddings, documents);

      // 내부 documents 배열에 추가
      this.documents.push(...documents);

      // 검색 인덱스 재구축 (전체 문서로)
      if (this.searchService) {
        this.searchService.buildSearchIndices(this.documents);
      }

      Logger.info(`Successfully added ${documents.length} documents to vector store`);
      return true;
    } catch (error) {
      Logger.error('Error adding documents to vector store', error as Error);
      return false;
    }
  }

  /**
   * 벡터 스토어에서 특정 문서들을 제거
   */
  async removeDocuments(documentsToRemove: Document<DocumentMetadata>[]): Promise<boolean> {
    try {
      if (!this.isInitialized || !this.store) {
        Logger.error('Vector store not initialized');
        return false;
      }

      if (documentsToRemove.length === 0) {
        Logger.info('No documents to remove');
        return true;
      }

      // 제거할 문서들의 ID 세트 생성
      const idsToRemove = new Set(
        documentsToRemove.map(doc => doc.metadata.nodeId)
      );

      // 내부 documents 배열에서 제거
      const originalLength = this.documents.length;
      this.documents = this.documents.filter(
        doc => !idsToRemove.has(doc.metadata.nodeId)
      );
      const removedCount = originalLength - this.documents.length;

      // MemoryVectorStore는 직접적인 제거를 지원하지 않으므로
      // 남은 문서들로 스토어를 재구성
      if (removedCount > 0) {
        Logger.info(`Rebuilding vector store after removing ${removedCount} documents`);
        
        // 남은 문서들의 임베딩을 다시 생성
        const remainingTexts = this.documents.map(doc => doc.pageContent);
        const newEmbeddings = await this.embeddingService.createEmbeddings(remainingTexts);
        
        if (!newEmbeddings) {
          Logger.error('Failed to create embeddings for remaining documents');
          return false;
        }

        // 새 스토어로 재초기화
        const success = await this.initializeStore(this.documents, newEmbeddings);
        if (!success) {
          Logger.error('Failed to reinitialize store after document removal');
          return false;
        }
      }

      Logger.info(`Successfully removed ${removedCount} documents from vector store`);
      return true;
    } catch (error) {
      Logger.error('Error removing documents from vector store', error as Error);
      return false;
    }
  }

  /**
   * 특정 노드 ID의 모든 문서들을 제거
   */
  async removeDocumentsByNodeId(nodeId: string): Promise<boolean> {
    try {
      const documentsToRemove = this.documents.filter(
        doc => doc.metadata.nodeId === nodeId
      );
      
      if (documentsToRemove.length === 0) {
        Logger.info(`No documents found for node ${nodeId}`);
        return true;
      }

      return await this.removeDocuments(documentsToRemove);
    } catch (error) {
      Logger.error(`Error removing documents for node ${nodeId}`, error as Error);
      return false;
    }
  }

  /**
   * 현재 벡터 스토어의 문서 개수 반환
   */
  getDocumentCount(): number {
    return this.documents.length;
  }

  /**
   * 특정 노드 ID의 문서들을 반환
   */
  getDocumentsByNodeId(nodeId: string): Document<DocumentMetadata>[] {
    return this.documents.filter(doc => doc.metadata.nodeId === nodeId);
  }
}
