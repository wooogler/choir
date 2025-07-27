import type { Document } from '@langchain/core/documents';
import { Logger } from '../common/logger';
import type { EmbeddingService } from './embedding-service';
import { MultiFileFAISSManager } from './multi-file-faiss-manager';
import { type DocumentMetadata, VectorStoreError } from './types';

/**
 * FAISS 기반 벡터 스토어 관리자 (멀티파일 전용)
 * - 파일별 독립 인덱스로 정확한 검색 보장
 * - 메모리 효율적인 LRU 캐시 관리
 * - 파일별 증분 업데이트 지원
 * - ChromaStoreManager와 완전 호환되는 인터페이스
 */
export class FAISSStoreManager {
  private multiFileManager: MultiFileFAISSManager;
  private isInitialized = false;

  constructor(embeddingService: EmbeddingService) {
    this.multiFileManager = new MultiFileFAISSManager(embeddingService);
    Logger.info('Using FAISS MultiFile vector store (file-based indexing)');
  }

  /**
   * 벡터 스토어 초기화
   */
  async initializeStore(documents: Document<DocumentMetadata>[], embeddings: number[][]): Promise<boolean> {
    try {
      // 초기화 로그는 MultiFileFAISSManager에서 처리
      const success = await this.multiFileManager.initialize(documents);
      this.isInitialized = success;

      if (!success) {
        Logger.error('Failed to initialize FAISS vector store');
      }

      return success;
    } catch (error) {
      Logger.error('Failed to initialize FAISS vector store', error as Error);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 문서 추가 (증분 업데이트)
   */
  async addDocuments(documents: Document<DocumentMetadata>[], embeddings: number[][]): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        Logger.error('FAISS store not initialized');
        return false;
      }

      if (documents.length === 0) {
        Logger.info('No documents to add');
        return true;
      }

      Logger.info(`Adding ${documents.length} documents to FAISS`);

      // 파일별로 그룹화하여 추가
      const fileGroups = new Map<string, Document<DocumentMetadata>[]>();
      for (const doc of documents) {
        const fileName = doc.metadata.fileName;
        if (!fileName) continue;

        if (!fileGroups.has(fileName)) {
          fileGroups.set(fileName, []);
        }
        fileGroups.get(fileName)!.push(doc);
      }

      // 각 파일별로 문서 추가
      for (const [fileName, fileDocs] of fileGroups.entries()) {
        await this.multiFileManager.addDocumentsToFile(fileName, fileDocs);
      }

      Logger.info(`Successfully added ${documents.length} documents to FAISS`);
      return true;
    } catch (error) {
      Logger.error('Failed to add documents to FAISS store', error as Error);
      return false;
    }
  }

  /**
   * 문서 제거
   */
  async removeDocuments(documentsToRemove: Document<DocumentMetadata>[]): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        Logger.error('FAISS store not initialized');
        return false;
      }

      if (documentsToRemove.length === 0) {
        Logger.info('No documents to remove');
        return true;
      }

      Logger.info(`Removing ${documentsToRemove.length} documents from FAISS`);

      // 파일별로 그룹화
      const fileGroups = new Map<string, string[]>();
      for (const doc of documentsToRemove) {
        const fileName = doc.metadata.fileName;
        const nodeId = doc.metadata.nodeId;
        if (!fileName || !nodeId) continue;

        if (!fileGroups.has(fileName)) {
          fileGroups.set(fileName, []);
        }
        fileGroups.get(fileName)!.push(nodeId);
      }

      // 각 파일에서 문서 제거
      for (const [fileName, nodeIds] of fileGroups.entries()) {
        await this.multiFileManager.removeDocumentsFromFile(fileName, nodeIds);
      }

      Logger.info(`Successfully removed ${documentsToRemove.length} documents from FAISS`);
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
      if (!this.isInitialized) {
        Logger.error('FAISS store not initialized');
        return false;
      }

      Logger.info(`Removing documents with nodeId: ${nodeId}`);

      // 모든 파일에서 해당 nodeId 제거 시도
      const fileList = this.multiFileManager.getFileList();
      for (const fileName of fileList) {
        await this.multiFileManager.removeDocumentsFromFile(fileName, [nodeId]);
      }

      Logger.info(`Successfully removed documents with nodeId: ${nodeId}`);
      return true;
    } catch (error) {
      Logger.error(`Error removing documents by nodeId ${nodeId}`, error as Error);
      return false;
    }
  }

  /**
   * 유사도 검색 (전체 파일에서)
   */
  async similaritySearch(query: string, k = 4): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!this.isInitialized) {
        Logger.error('FAISS: Vector store not initialized for search');
        throw new VectorStoreError('Vector store not initialized');
      }

      Logger.info(
        `FAISS: Performing similarity search for query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}" with k=${k}`,
      );

      const results = await this.multiFileManager.searchGlobal(query, k);

      Logger.info(`FAISS: Search returned ${results.length} results`);
      return results;
    } catch (error) {
      Logger.error('FAISS: Error performing similarity search', error as Error);
      throw new VectorStoreError('Similarity search failed');
    }
  }

  /**
   * 파일별 유사도 검색
   */
  async similaritySearchByFile(query: string, fileName: string, k = 4): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!this.isInitialized) {
        Logger.error('FAISS: Vector store not initialized for search');
        throw new VectorStoreError('Vector store not initialized');
      }

      Logger.info(
        `FAISS: Performing file-specific search in "${fileName}" for query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}" with k=${k}`,
      );

      const results = await this.multiFileManager.searchInFile(query, fileName, k);

      Logger.info(`FAISS: File-specific search returned ${results.length} results`);
      return results;
    } catch (error) {
      Logger.error(`FAISS: Error performing file-specific search in ${fileName}`, error as Error);
      throw new VectorStoreError(`File-specific search failed for ${fileName}`);
    }
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
    return this.multiFileManager.getDocuments();
  }

  /**
   * 스토어 리셋
   */
  reset(): void {
    this.isInitialized = false;
    // MultiFileFAISSManager에 reset 메서드가 있다면 호출
    // this.multiFileManager.reset();
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
   * 쓰기 가능한 파일들에서만 유사도 검색
   */
  async similaritySearchWritableFiles(
    query: string,
    readOnlyFiles: string[],
    k = 4,
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!this.isInitialized) {
        Logger.error('FAISS: Vector store not initialized for search');
        throw new VectorStoreError('Vector store not initialized');
      }

      Logger.info(
        `FAISS: Performing writable files search for query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}" with k=${k}, excluding ${readOnlyFiles.length} read-only files`,
      );

      const results = await this.multiFileManager.searchWritableFiles(query, k);

      Logger.info(`FAISS: Writable files search returned ${results.length} results`);
      return results;
    } catch (error) {
      Logger.error('FAISS: Error performing writable files search', error as Error);
      throw new VectorStoreError('Writable files search failed');
    }
  }

  /**
   * 읽기 전용 파일 설정 변경 시 쓰기 가능한 파일 인덱스 업데이트
   */
  async updateReadOnlyFiles(readOnlyFiles: string[]): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        Logger.error('FAISS: Vector store not initialized');
        return false;
      }

      Logger.info(`FAISS: Updating read-only files configuration, ${readOnlyFiles.length} files set as read-only`);

      const success = await this.multiFileManager.updateWritableStore(readOnlyFiles);

      if (success) {
        Logger.info('FAISS: Successfully updated writable files index');
      } else {
        Logger.error('FAISS: Failed to update writable files index');
      }

      return success;
    } catch (error) {
      Logger.error('FAISS: Error updating read-only files configuration', error as Error);
      return false;
    }
  }

  /**
   * 진단 정보 반환
   */
  getDiagnostics(): any {
    const multiFileStats = this.multiFileManager.getDiagnostics();
    return {
      ...multiFileStats,
      details: {
        ...multiFileStats.details,
        storeType: 'faiss-multifile',
        mode: 'multi-file',
      },
    };
  }
}
