import fs from 'fs';
import path from 'path';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { Document } from '@langchain/core/documents';
import { Logger } from '../common/logger';
import type { EmbeddingService } from './embedding-service';
import { type DocumentMetadata, VectorStoreError } from './types';

interface FileStoreInfo {
  store: FaissStore;
  documentCount: number;
  lastAccessed: number;
  isLoaded: boolean;
}

/**
 * 파일별 FAISS 인덱스를 관리하는 매니저
 * - 각 파일마다 독립적인 FAISS 인덱스 생성
 * - 메모리 효율적인 LRU 캐시 관리
 * - 파일별 증분 업데이트 지원
 * - 정확한 파일별 검색 보장
 */
export class MultiFileFAISSManager {
  private fileStores = new Map<string, FileStoreInfo>();
  private globalStore: FaissStore | null = null;
  private embeddingService: EmbeddingService;
  private indexBasePath: string;
  private maxLoadedStores: number;
  private isInitialized = false;

  // 파일별 문서 캐시
  private fileDocuments = new Map<string, Document<DocumentMetadata>[]>();

  constructor(embeddingService: EmbeddingService, maxLoadedStores = 10) {
    this.embeddingService = embeddingService;
    this.maxLoadedStores = maxLoadedStores;
    this.indexBasePath = path.join(process.cwd(), 'data', 'multi-faiss-index');

    // 인덱스 디렉토리 생성
    if (!fs.existsSync(this.indexBasePath)) {
      fs.mkdirSync(this.indexBasePath, { recursive: true });
    }
  }

  /**
   * 전체 시스템 초기화
   */
  async initialize(documents: Document<DocumentMetadata>[]): Promise<boolean> {
    try {
      Logger.info(`Initializing FAISS vector store with ${documents.length} documents (file-based indexing)`);

      // 파일별로 문서 그룹화
      const fileGroups = this.groupDocumentsByFile(documents);
      
      // 전역 스토어 생성
      await this.initializeGlobalStore(documents);

      // 각 파일별 인덱스 생성
      for (const [fileName, fileDocs] of fileGroups.entries()) {
        await this.createFileIndex(fileName, fileDocs);
      }

      this.isInitialized = true;
      Logger.info(`Successfully initialized FAISS with ${fileGroups.size} file indexes and ${documents.length} total documents`);
      return true;
    } catch (error) {
      Logger.error('Failed to initialize MultiFile FAISS manager', error as Error);
      return false;
    }
  }

  /**
   * 파일별 검색
   */
  async searchInFile(query: string, fileName: string, k = 4): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!this.isInitialized) {
        throw new VectorStoreError('MultiFile FAISS manager not initialized');
      }

      Logger.info(`MultiFile FAISS: Searching in file "${fileName}" with query: "${query.substring(0, 50)}..." k=${k}`);

      const storeInfo = this.fileStores.get(fileName);
      if (!storeInfo) {
        Logger.warn(`MultiFile FAISS: No index found for file: ${fileName}`);
        return [];
      }

      // 스토어 로드 (필요시)
      await this.ensureStoreLoaded(fileName);

      // 검색 수행
      const results = await storeInfo.store.similaritySearch(query, k);
      
      // 접근 시간 업데이트
      storeInfo.lastAccessed = Date.now();

      Logger.info(`MultiFile FAISS: File search in "${fileName}" returned ${results.length} results`);
      return this.deserializeResults(results);
    } catch (error) {
      Logger.error(`Error searching in file ${fileName}`, error as Error);
      throw new VectorStoreError(`File search failed for ${fileName}`);
    }
  }

  /**
   * 전역 검색 (모든 파일에서)
   */
  async searchGlobal(query: string, k = 4): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!this.isInitialized || !this.globalStore) {
        throw new VectorStoreError('Global store not initialized');
      }

      Logger.info(`MultiFile FAISS: Performing global search with query: "${query.substring(0, 50)}..." k=${k}`);
      const results = await this.globalStore.similaritySearch(query, k);
      
      Logger.info(`MultiFile FAISS: Global search returned ${results.length} results`);
      return this.deserializeResults(results);
    } catch (error) {
      Logger.error('Error performing global search', error as Error);
      throw new VectorStoreError('Global search failed');
    }
  }

  /**
   * 파일별 문서 추가 (증분 업데이트)
   */
  async addDocumentsToFile(fileName: string, documents: Document<DocumentMetadata>[]): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        throw new VectorStoreError('MultiFile FAISS manager not initialized');
      }

      Logger.info(`Adding ${documents.length} documents to file: ${fileName}`);

      // 파일 인덱스가 없으면 새로 생성
      if (!this.fileStores.has(fileName)) {
        await this.createFileIndex(fileName, documents);
      } else {
        // 기존 인덱스에 추가
        const storeInfo = this.fileStores.get(fileName)!;
        await this.ensureStoreLoaded(fileName);

        const serializedDocs = this.serializeDocumentsMetadata(documents);
        await storeInfo.store.addDocuments(serializedDocs);
        
        storeInfo.documentCount += documents.length;
        storeInfo.lastAccessed = Date.now();

        // 파일 문서 캐시 업데이트
        const existingDocs = this.fileDocuments.get(fileName) || [];
        this.fileDocuments.set(fileName, [...existingDocs, ...documents]);

        // 인덱스 저장
        await this.saveFileIndex(fileName);
      }

      // 글로벌 스토어에도 추가
      if (this.globalStore) {
        const serializedDocs = this.serializeDocumentsMetadata(documents);
        await this.globalStore.addDocuments(serializedDocs);
        await this.saveGlobalIndex();
      }

      Logger.info(`Successfully added documents to file: ${fileName}`);
      return true;
    } catch (error) {
      Logger.error(`Failed to add documents to file ${fileName}`, error as Error);
      return false;
    }
  }

  /**
   * 파일별 문서 제거
   */
  async removeDocumentsFromFile(fileName: string, nodeIds: string[]): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        throw new VectorStoreError('MultiFile FAISS manager not initialized');
      }

      Logger.info(`Removing ${nodeIds.length} documents from file: ${fileName}`);

      const storeInfo = this.fileStores.get(fileName);
      if (!storeInfo) {
        Logger.warn(`No index found for file: ${fileName}`);
        return true;
      }

      // 파일 문서 캐시에서 제거
      const fileDocs = this.fileDocuments.get(fileName) || [];
      const nodeIdSet = new Set(nodeIds);
      const filteredDocs = fileDocs.filter(doc => !nodeIdSet.has(doc.metadata.nodeId || ''));

      if (filteredDocs.length === 0) {
        // 파일의 모든 문서가 제거된 경우
        await this.removeFileIndex(fileName);
      } else {
        // 남은 문서로 인덱스 재구축
        this.fileDocuments.set(fileName, filteredDocs);
        await this.recreateFileIndex(fileName, filteredDocs);
      }

      Logger.info(`Successfully removed documents from file: ${fileName}`);
      return true;
    } catch (error) {
      Logger.error(`Failed to remove documents from file ${fileName}`, error as Error);
      return false;
    }
  }

  /**
   * 전체 파일 제거
   */
  async removeFile(fileName: string): Promise<boolean> {
    try {
      Logger.info(`Removing entire file index: ${fileName}`);
      await this.removeFileIndex(fileName);
      this.fileDocuments.delete(fileName);
      return true;
    } catch (error) {
      Logger.error(`Failed to remove file ${fileName}`, error as Error);
      return false;
    }
  }

  /**
   * 파일 목록 조회
   */
  getFileList(): string[] {
    return Array.from(this.fileStores.keys());
  }

  /**
   * 모든 문서 반환 (전체 문서 수 조회용)
   */
  getDocuments(): Document<DocumentMetadata>[] {
    const allDocuments: Document<DocumentMetadata>[] = [];
    for (const docs of this.fileDocuments.values()) {
      allDocuments.push(...docs);
    }
    return allDocuments;
  }

  /**
   * 진단 정보
   */
  getDiagnostics(): any {
    const fileStats = Array.from(this.fileStores.entries()).map(([fileName, info]) => ({
      fileName,
      documentCount: info.documentCount,
      isLoaded: info.isLoaded,
      lastAccessed: new Date(info.lastAccessed).toISOString()
    }));

    // 전체 문서 수 계산
    const totalDocumentCount = Array.from(this.fileStores.values()).reduce(
      (sum, info) => sum + info.documentCount, 
      0
    );

    return {
      status: this.isInitialized ? 'healthy' : 'error',
      details: {
        isInitialized: this.isInitialized,
        documentCount: totalDocumentCount, // App home에서 기대하는 필드
        vectorsCount: totalDocumentCount,  // App home에서 기대하는 필드 (각 문서마다 하나의 벡터)
        totalFiles: this.fileStores.size,
        loadedStores: Array.from(this.fileStores.values()).filter(info => info.isLoaded).length,
        maxLoadedStores: this.maxLoadedStores,
        hasGlobalStore: !!this.globalStore,
        fileStats
      }
    };
  }

  // === Private Methods ===

  private groupDocumentsByFile(documents: Document<DocumentMetadata>[]): Map<string, Document<DocumentMetadata>[]> {
    const groups = new Map<string, Document<DocumentMetadata>[]>();
    
    for (const doc of documents) {
      const fileName = doc.metadata.fileName;
      if (!fileName) continue;

      if (!groups.has(fileName)) {
        groups.set(fileName, []);
      }
      groups.get(fileName)!.push(doc);
    }

    return groups;
  }

  private async initializeGlobalStore(documents: Document<DocumentMetadata>[]): Promise<void> {
    const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
    
    if (documents.length === 0) {
      this.globalStore = new FaissStore(openAIEmbeddings, {});
      return;
    }

    const serializedDocs = this.serializeDocumentsMetadata(documents);
    this.globalStore = await FaissStore.fromDocuments(serializedDocs, openAIEmbeddings);
    await this.saveGlobalIndex();
  }

  private async createFileIndex(fileName: string, documents: Document<DocumentMetadata>[]): Promise<void> {
    const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
    
    let store: FaissStore;
    if (documents.length === 0) {
      store = new FaissStore(openAIEmbeddings, {});
    } else {
      const serializedDocs = this.serializeDocumentsMetadata(documents);
      store = await FaissStore.fromDocuments(serializedDocs, openAIEmbeddings);
    }

    const storeInfo: FileStoreInfo = {
      store,
      documentCount: documents.length,
      lastAccessed: Date.now(),
      isLoaded: true
    };

    this.fileStores.set(fileName, storeInfo);
    this.fileDocuments.set(fileName, documents);
    
    await this.saveFileIndex(fileName);
    await this.manageMemory();
  }

  private async recreateFileIndex(fileName: string, documents: Document<DocumentMetadata>[]): Promise<void> {
    await this.createFileIndex(fileName, documents);
  }

  private async removeFileIndex(fileName: string): Promise<void> {
    this.fileStores.delete(fileName);
    
    // 파일 시스템에서 인덱스 파일 삭제
    const fileIndexPath = this.getFileIndexPath(fileName);
    try {
      if (fs.existsSync(`${fileIndexPath}.faiss`)) {
        fs.unlinkSync(`${fileIndexPath}.faiss`);
      }
      if (fs.existsSync(`${fileIndexPath}.pkl`)) {
        fs.unlinkSync(`${fileIndexPath}.pkl`);
      }
    } catch (error) {
      Logger.warn(`Failed to delete index files for ${fileName}`, error as Error);
    }
  }

  private async ensureStoreLoaded(fileName: string): Promise<void> {
    const storeInfo = this.fileStores.get(fileName);
    if (!storeInfo || storeInfo.isLoaded) return;

    // 인덱스 파일에서 로드
    const fileIndexPath = this.getFileIndexPath(fileName);
    const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
    
    try {
      storeInfo.store = await FaissStore.load(fileIndexPath, openAIEmbeddings);
      storeInfo.isLoaded = true;
      storeInfo.lastAccessed = Date.now();
      
      await this.manageMemory();
    } catch (error) {
      Logger.error(`Failed to load index for file ${fileName}`, error as Error);
      throw error;
    }
  }

  private async manageMemory(): Promise<void> {
    const loadedStores = Array.from(this.fileStores.entries())
      .filter(([_, info]) => info.isLoaded)
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    while (loadedStores.length > this.maxLoadedStores) {
      const [fileName, storeInfo] = loadedStores.shift()!;
      
      // 메모리에서 언로드 (인덱스 파일은 유지)
      storeInfo.isLoaded = false;
      Logger.info(`Unloaded index for file: ${fileName} (memory management)`);
    }
  }

  private async saveFileIndex(fileName: string): Promise<void> {
    const storeInfo = this.fileStores.get(fileName);
    if (!storeInfo) return;

    const fileIndexPath = this.getFileIndexPath(fileName);
    try {
      await storeInfo.store.save(fileIndexPath);
    } catch (error) {
      Logger.warn(`Failed to save index for file ${fileName}`, error as Error);
    }
  }

  private async saveGlobalIndex(): Promise<void> {
    if (!this.globalStore) return;

    const globalIndexPath = path.join(this.indexBasePath, 'global');
    try {
      await this.globalStore.save(globalIndexPath);
    } catch (error) {
      Logger.warn('Failed to save global index', error as Error);
    }
  }

  private getFileIndexPath(fileName: string): string {
    // 파일명을 안전한 경로로 변환
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    return path.join(this.indexBasePath, safeFileName);
  }

  private serializeDocumentsMetadata(documents: Document<DocumentMetadata>[]): Document<DocumentMetadata>[] {
    return documents.map((doc) => {
      const serializedMetadata = { ...doc.metadata };

      if (serializedMetadata.webContent && Array.isArray(serializedMetadata.webContent)) {
        (serializedMetadata as any).webContent = JSON.stringify(serializedMetadata.webContent);
      }

      return new Document({
        pageContent: doc.pageContent,
        metadata: serializedMetadata,
      });
    });
  }

  private deserializeResults(results: Document[]): Document<DocumentMetadata>[] {
    return results.map((doc) => {
      const metadata = { ...doc.metadata };

      if (metadata.webContent && typeof metadata.webContent === 'string') {
        try {
          metadata.webContent = JSON.parse(metadata.webContent);
        } catch (parseError) {
          Logger.warn(`Failed to parse webContent: ${parseError}`);
          metadata.webContent = undefined;
        }
      }

      return new Document({
        pageContent: doc.pageContent,
        metadata: metadata as DocumentMetadata,
      });
    });
  }
}