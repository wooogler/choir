import { Document } from '@langchain/core/documents';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { EmbeddingService } from './embedding-service';
import { VectorStoreError, type DocumentMetadata } from './types';
import { Logger } from '../common/logger';
import path from 'path';
import fs from 'fs';

/**
 * FAISS 기반 벡터 스토어 관리자
 * - ChromaStoreManager와 완전 호환
 * - 안정적인 증분 업데이트 지원
 * - 로컬 파일 저장/로드
 * - 뛰어난 성능
 */
export class FAISSStoreManager {
  private store: FaissStore | null = null;
  private isInitialized = false;
  private documents: Document<DocumentMetadata>[] = [];
  private embeddingService: EmbeddingService;
  private indexPath: string;
  private documentIdMap = new Map<string, number>(); // nodeId -> FAISS index mapping

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
    this.indexPath = path.join(process.cwd(), 'data', 'faiss-index');
    
    // 인덱스 디렉토리 생성
    const indexDir = path.dirname(this.indexPath);
    if (!fs.existsSync(indexDir)) {
      fs.mkdirSync(indexDir, { recursive: true });
    }
  }

  /**
   * 벡터 스토어 초기화
   */
  async initializeStore(documents: Document<DocumentMetadata>[], embeddings: number[][], isFromCache = false): Promise<boolean> {
    try {
      Logger.info(`Initializing FAISS vector store with ${documents.length} documents${isFromCache ? ' (from cache)' : ' (fresh build)'}`);
      
      // 강제 새로고침인 경우 모든 내부 상태 초기화
      if (!isFromCache) {
        Logger.info('Force refresh detected: clearing all internal state');
        this.documents = [];
        this.documentIdMap.clear();
        this.store = null;
        this.isInitialized = false;
      }
      
      // FAISS는 중복 처리가 내장되어 있어 별도 중복 제거 불필요
      this.documents = documents;
      this.documentIdMap.clear();

      const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
      
      if (documents.length === 0) {
        Logger.info('No documents to index, creating empty FAISS store');
        this.store = new FaissStore(openAIEmbeddings, {});
        this.isInitialized = true;
        return true;
      }

      // 기존 인덱스 파일 삭제 (새로 빌드할 때만)
      if (!isFromCache) {
        await this.clearExistingIndex();
      }

      // 메타데이터 직렬화
      const serializedDocuments = this.serializeDocumentsMetadata(documents);
      
      // FAISS 인덱스 생성
      this.store = await FaissStore.fromDocuments(serializedDocuments, openAIEmbeddings);
      
      // 문서 ID 매핑 생성
      serializedDocuments.forEach((doc, index) => {
        const nodeId = doc.metadata.nodeId;
        if (nodeId) {
          this.documentIdMap.set(nodeId, index);
        }
      });

      // 인덱스 파일로 저장
      await this.saveIndex();
      
      this.isInitialized = true;
      
      Logger.info(`Successfully initialized FAISS vector store with ${documents.length} documents`);
      return true;
    } catch (error) {
      Logger.error('Failed to initialize FAISS vector store', error as Error);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 문서 추가 (증분 업데이트) - ChromaStoreManager와 동일한 로직
   */
  async addDocuments(documents: Document<DocumentMetadata>[], embeddings: number[][]): Promise<boolean> {
    try {
      if (!this.isInitialized || !this.store) {
        Logger.error('FAISS store not initialized');
        return false;
      }

      if (documents.length === 0) {
        Logger.info('No documents to add');
        return true;
      }

      Logger.info(`Adding ${documents.length} documents to FAISS`);

      // 메타데이터 직렬화
      const serializedDocuments = this.serializeDocumentsMetadata(documents);
      
      // FAISS에 문서 추가
      await this.store.addDocuments(serializedDocuments);
      
      // 내부 문서 배열 업데이트
      this.documents.push(...documents);
      
      // ID 매핑 업데이트
      const startIndex = this.documents.length - documents.length;
      documents.forEach((doc, index) => {
        const nodeId = doc.metadata.nodeId;
        if (nodeId) {
          this.documentIdMap.set(nodeId, startIndex + index);
        }
      });


      // 인덱스 저장
      await this.saveIndex();
      
      Logger.info(`Successfully added ${documents.length} documents to FAISS`);
      return true;
    } catch (error) {
      Logger.error('Failed to add documents to FAISS store', error as Error);
      return false;
    }
  }

  /**
   * 문서 제거 - ChromaStoreManager와 동일한 로직
   */
  async removeDocuments(documentsToRemove: Document<DocumentMetadata>[]): Promise<boolean> {
    try {
      if (!this.isInitialized || !this.store) {
        Logger.error('FAISS store not initialized');
        return false;
      }

      if (documentsToRemove.length === 0) {
        Logger.info('No documents to remove');
        return true;
      }

      Logger.info(`Removing ${documentsToRemove.length} documents from FAISS`);
      
      const nodeIdsToRemove = documentsToRemove
        .map(doc => doc.metadata.nodeId)
        .filter((nodeId): nodeId is string => nodeId !== undefined);

      if (nodeIdsToRemove.length === 0) {
        Logger.info('No valid nodeIds to remove');
        return true;
      }

      // 내부 documents 배열에서 제거
      const idsToRemoveSet = new Set(nodeIdsToRemove);
      const originalLength = this.documents.length;
      this.documents = this.documents.filter(doc => doc.metadata.nodeId && !idsToRemoveSet.has(doc.metadata.nodeId));
      const removedCount = originalLength - this.documents.length;

      // FAISS는 직접적인 문서 제거를 지원하지 않으므로 재구축
      if (this.documents.length > 0) {
        const texts = this.documents.map(doc => doc.pageContent);
        const embeddings = await this.embeddingService.createEmbeddings(texts);
        await this.initializeStore(this.documents, embeddings, false);
      } else {
        // 모든 문서가 제거된 경우 빈 스토어 생성
        const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
        this.store = new FaissStore(openAIEmbeddings, {});
        await this.clearExistingIndex();
      }


      Logger.info(`Successfully removed ${removedCount} documents from FAISS`);
      return true;
    } catch (error) {
      Logger.error('Failed to remove documents from FAISS store', error as Error);
      return false;
    }
  }

  /**
   * nodeId로 문서 제거
   */
  async removeDocumentsByNodeId(nodeId: string): Promise<boolean> {
    try {
      const documentsToRemove = this.documents.filter(doc => doc.metadata.nodeId === nodeId);
      return await this.removeDocuments(documentsToRemove);
    } catch (error) {
      Logger.error(`Error removing documents by nodeId ${nodeId}`, error as Error);
      return false;
    }
  }

  /**
   * 유사도 검색 - ChromaStoreManager와 동일한 로직
   */
  async similaritySearch(
    query: string,
    k = 4,
    filter?: Record<string, any>
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!this.isInitialized || !this.store) {
        Logger.error('FAISS: Vector store not initialized for search');
        throw new VectorStoreError('Vector store not initialized');
      }

      Logger.info(`FAISS: Performing similarity search for query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}" with k=${k}`);
      
      // DIAGNOSTIC: 내부 문서 상태 확인
      Logger.info(`FAISS: Internal documents count: ${this.documents.length}`);
      const nodeIdCounts = new Map<string, number>();
      this.documents.forEach(doc => {
        const nodeId = doc.metadata.nodeId;
        if (nodeId) {
          nodeIdCounts.set(nodeId, (nodeIdCounts.get(nodeId) || 0) + 1);
        }
      });
      const duplicateNodeIds = Array.from(nodeIdCounts.entries()).filter(([_, count]) => count > 1);
      if (duplicateNodeIds.length > 0) {
        Logger.warn(`FAISS: Found duplicate nodeIds in internal documents:`, duplicateNodeIds);
      }
      
      // FAISS 검색 수행
      const results = await this.store.similaritySearch(query, k, filter);
      
      Logger.info(`FAISS: Search returned ${results.length} results`);
      
      // DIAGNOSTIC: 검색 결과 중복 확인
      const resultNodeIds = results.map(doc => doc.metadata.nodeId);
      const resultNodeIdCounts = new Map<string, number>();
      resultNodeIds.forEach(nodeId => {
        if (nodeId) {
          resultNodeIdCounts.set(nodeId, (resultNodeIdCounts.get(nodeId) || 0) + 1);
        }
      });
      const duplicateResultNodeIds = Array.from(resultNodeIdCounts.entries()).filter(([_, count]) => count > 1);
      if (duplicateResultNodeIds.length > 0) {
        Logger.warn(`FAISS: Found duplicate nodeIds in search results:`, duplicateResultNodeIds);
      }
      
      // 결과 처리 및 메타데이터 역직렬화
      const processedResults = results.map((doc, index) => {
        Logger.info(`FAISS: Processing document ${index}`);
        
        try {
          const metadata = { ...doc.metadata };
          
          // webContent 역직렬화
          if (metadata.webContent && typeof metadata.webContent === 'string') {
            try {
              metadata.webContent = JSON.parse(metadata.webContent);
            } catch (parseError) {
              Logger.warn(`Failed to parse webContent for document ${index}: ${parseError}`);
              metadata.webContent = undefined;
            }
          }
          
          return new Document({
            pageContent: doc.pageContent,
            metadata: metadata as DocumentMetadata
          });
        } catch (docError) {
          Logger.error(`Error processing document ${index} in search results: ${docError}`);
          return new Document({
            pageContent: doc.pageContent,
            metadata: doc.metadata as DocumentMetadata
          });
        }
      });
      
      Logger.info(`FAISS: Successfully processed ${processedResults.length} search results`);
      
      // 디버그: 검색 결과 샘플 로그
      if (processedResults.length > 0) {
        const firstResult = processedResults[0];
        Logger.info(`FAISS: First result sample - File: ${firstResult.metadata?.fileName}, NodeId: ${firstResult.metadata?.nodeId}, Content: "${firstResult.pageContent.substring(0, 100)}..."`);
      }
      
      return processedResults;
    } catch (error) {
      Logger.error('FAISS: Error performing similarity search', error as Error);
      throw new VectorStoreError('Similarity search failed');
    }
  }

  /**
   * 파일별 유사도 검색
   */
  async similaritySearchByFile(
    query: string,
    fileName: string,
    k = 4
  ): Promise<Document<DocumentMetadata>[]> {
    return this.similaritySearch(query, k, { fileName });
  }

  /**
   * 초기화 상태 확인
   */
  isStoreInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * 모든 문서 반환
   */
  getDocuments(): Document<DocumentMetadata>[] {
    return this.documents;
  }

  /**
   * 스토어 리셋
   */
  reset(): void {
    this.store = null;
    this.isInitialized = false;
    this.documents = [];
    this.documentIdMap.clear();
  }


  /**
   * 초기화 상태 확인 (호환성)
   */
  checkInitialized(): void {
    if (!this.isInitialized) {
      throw new VectorStoreError('Vector store not initialized');
    }
  }

  /**
   * 진단 정보 반환
   */
  getDiagnostics(): any {
    return {
      status: this.isInitialized ? 'healthy' : 'error',
      details: {
        isInitialized: this.isInitialized,
        documentCount: this.documents.length,
        vectorsCount: this.documents.length, // Each document has one vector
        storeType: 'faiss',
        indexPath: this.indexPath,
        documentIdMapSize: this.documentIdMap.size,
      }
    };
  }

  /**
   * 인덱스 파일 저장
   */
  private async saveIndex(): Promise<void> {
    try {
      if (this.store) {
        await this.store.save(this.indexPath);
        Logger.info(`FAISS index saved to ${this.indexPath}`);
      }
    } catch (error) {
      Logger.warn('Failed to save FAISS index', error as Error);
    }
  }

  /**
   * 인덱스 파일 로드
   */
  private async loadIndex(): Promise<boolean> {
    try {
      if (fs.existsSync(`${this.indexPath}.faiss`)) {
        const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
        this.store = await FaissStore.load(this.indexPath, openAIEmbeddings);
        Logger.info(`FAISS index loaded from ${this.indexPath}`);
        return true;
      }
      return false;
    } catch (error) {
      Logger.warn('Failed to load FAISS index', error as Error);
      return false;
    }
  }

  /**
   * 기존 인덱스 파일 삭제
   */
  private async clearExistingIndex(): Promise<void> {
    try {
      const faissFile = `${this.indexPath}.faiss`;
      const pklFile = `${this.indexPath}.pkl`;
      
      if (fs.existsSync(faissFile)) {
        fs.unlinkSync(faissFile);
        Logger.info('Deleted existing FAISS index file');
      }
      
      if (fs.existsSync(pklFile)) {
        fs.unlinkSync(pklFile);
        Logger.info('Deleted existing FAISS pickle file');
      }
    } catch (error) {
      Logger.warn('Failed to clear existing FAISS index', error as Error);
    }
  }

  /**
   * 메타데이터 직렬화 - FAISS 호환성을 위해 배열/객체를 JSON 문자열로 변환
   */
  private serializeDocumentsMetadata(documents: Document<DocumentMetadata>[]): Document<DocumentMetadata>[] {
    return documents.map(doc => {
      const serializedMetadata = { ...doc.metadata };
      
      // webContent 배열을 JSON 문자열로 직렬화
      if (serializedMetadata.webContent && Array.isArray(serializedMetadata.webContent)) {
        (serializedMetadata as any).webContent = JSON.stringify(serializedMetadata.webContent);
      }

      return new Document({
        pageContent: doc.pageContent,
        metadata: serializedMetadata
      });
    });
  }

} 