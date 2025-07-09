import { Document } from '@langchain/core/documents';
import { ErrorCodes } from 'services/common/error-handler';
import { Logger } from 'services/common/logger';
import { DocumentTree } from 'services/document';
import { appendNodeContent, createNewSectionNode, updateNodeContent } from 'services/document/markdown';
import type { SlackMessage } from 'services/slack';
import type { MarkdownFile } from '../github';
import { formatHeadingContext } from '../llm/langchain';
import { VectorCacheManager } from './cache-manager';
import { DocumentProcessor } from './document-processor';
import { EmbeddingService } from './embedding-service';
import { VectorStoreManager } from './store-manager';
import { type DocumentMetadata, VectorStoreError } from './types';

/**
 * 벡터 스토어의 주요 기능을 담당하는 서비스 클래스
 */
export class VectorStoreService {
  private static instance: VectorStoreService;

  private embeddingService: EmbeddingService;
  private cacheManager: VectorCacheManager;
  private storeManager: VectorStoreManager;
  private documentProcessor: DocumentProcessor;
  private markdownFiles: MarkdownFile[] = [];
  private cacheId = '';

  // 증분 업데이트를 위한 노드별 Document 추적
  private nodeDocumentMap = new Map<string, Document<DocumentMetadata>[]>();

  private constructor(apiKey?: string) {
    this.embeddingService = new EmbeddingService(apiKey);
    this.cacheManager = new VectorCacheManager();
    this.storeManager = new VectorStoreManager(this.embeddingService);
    this.documentProcessor = new DocumentProcessor();

    const provider = this.embeddingService.getProvider();
    Logger.info(`VectorStoreService instance created with ${provider} provider`);
  }

  public static getInstance(): VectorStoreService {
    if (!VectorStoreService.instance) {
      VectorStoreService.instance = new VectorStoreService();
    }
    return VectorStoreService.instance;
  }

  /**
   * 벡터 스토어 초기화
   */
  public async initialize(markdownFiles: MarkdownFile[], useCache = true, forceRefresh = false): Promise<boolean> {
    Logger.info(
      `Initializing Vector Store with ${markdownFiles.length} files (useCache=${useCache}, forceRefresh=${forceRefresh})`,
    );

    try {
      this.markdownFiles = markdownFiles;

      if (!this.markdownFiles.length) {
        Logger.info('No documents loaded, starting with empty vector store');
        return await this.storeManager.initializeStore([], []);
      }

      this.cacheId = this.cacheManager.generateCacheId();
      const buildSuccess = await this.buildVectorStore(this.markdownFiles, useCache, forceRefresh);

      if (!buildSuccess) {
        Logger.error('Failed to build vector store');
        return false;
      }

      Logger.info(`Vector store initialized with ${this.storeManager.getDocuments().length} documents`);
      return true;
    } catch (error) {
      Logger.error('Failed to initialize vector store', error as Error);
      return false;
    }
  }

  /**
   * 벡터 스토어 구축
   */
  private async buildVectorStore(
    markdownFiles: MarkdownFile[],
    useCache = true,
    forceRefresh = false,
  ): Promise<boolean> {
    try {
      Logger.info(`Building vector store (useCache=${useCache}, forceRefresh=${forceRefresh})`);

      if (!useCache || forceRefresh) {
        return await this.buildVectorStoreFromFiles(markdownFiles);
      }

      const isCacheValid = await this.cacheManager.validateCache(markdownFiles);

      if (isCacheValid) {
        Logger.info('Valid cache found, loading from cache');
        return await this.restoreFromCache();
      }

      Logger.info('No valid cache found, building from files');
      return await this.buildVectorStoreFromFiles(markdownFiles);
    } catch (error) {
      Logger.error('Error building vector store', error as Error);
      return false;
    }
  }

  /**
   * 파일로부터 벡터 스토어 구축
   */
  private async buildVectorStoreFromFiles(markdownFiles: MarkdownFile[]): Promise<boolean> {
    try {
      Logger.info(`Building vector store from ${markdownFiles.length} files`);

      const documents = await this.documentProcessor.prepareDocuments(markdownFiles);
      if (documents.length === 0) {
        Logger.warn('No valid documents found, initializing empty vector store');
        return await this.storeManager.initializeStore([], []);
      }

      const texts = this.documentProcessor.prepareTextsForEmbedding(documents);
      Logger.info(`Extracted and preprocessed ${texts.length} text chunks for embedding generation`);

      if (texts.length > 0) {
        const originalSample = documents[0].pageContent.substring(0, 100);
        const preprocessedSample = texts[0].substring(0, 100);
        Logger.info(
          `Preprocessing sample:\nOriginal: "${originalSample}..."\nPreprocessed: "${preprocessedSample}..."`,
        );
      }

      const embeddings = await this.embeddingService.createEmbeddings(texts);
      if (!embeddings || embeddings.length === 0) {
        Logger.error('Failed to create embeddings');
        return false;
      }

      const documentTrees = this.documentProcessor.collectDocumentTrees(markdownFiles);

      await this.cacheManager.saveEmbeddingsCache({
        documents,
        embeddings,
        contentHash: await this.cacheManager.generateContentHash(markdownFiles),
        timestamp: Date.now(),
        documentTrees,
      });

      return await this.storeManager.initializeStore(documents, embeddings);
    } catch (error) {
      Logger.error('Error building vector store from files', error as Error);
      return false;
    }
  }

  /**
   * 캐시에서 벡터 스토어 복원
   */
  private async restoreFromCache(): Promise<boolean> {
    try {
      Logger.info('Attempting to restore vector store from cache');

      const firstFile = this.markdownFiles[0];
      let owner = 'default';
      let repo = 'default';

      if (firstFile.githubUrl && firstFile.githubUrl.includes('github.com')) {
        const match = firstFile.githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (match && match.length >= 3) {
          owner = match[1];
          repo = match[2];
        }
      }

      const cacheFilePath = this.cacheManager.getCacheFilePath(owner, repo);
      await this.cacheManager.logCacheStatus(cacheFilePath);

      const cacheData = await this.cacheManager.loadEmbeddingsCache(cacheFilePath, this.markdownFiles);

      if (!cacheData) {
        Logger.info('No valid cache data found');
        return false;
      }

      const documents = cacheData.documents;
      const embeddings = cacheData.embeddings;

      if (cacheData.documentTrees && cacheData.documentTrees.size > 0) {
        Logger.info(`Found ${cacheData.documentTrees.size} document trees in cache`);

        this.markdownFiles.forEach((file) => {
          if (cacheData.documentTrees?.has(file.name)) {
            const cachedTree = cacheData.documentTrees.get(file.name);
            if (cachedTree) {
              file.tree = cachedTree;
              Logger.info(`Restored document tree for ${file.name}`);
            }
          }
        });
      }

      const success = await this.storeManager.initializeStore(documents, embeddings);

      if (success) {
        Logger.info(`Successfully restored vector store from cache with ${documents.length} documents`);
      }

      return success;
    } catch (error) {
      Logger.error('Error restoring vector store from cache', error as Error);
      return false;
    }
  }

  /**
   * 유사도 검색 수행
   */
  public async similaritySearch(query: string, k = 5): Promise<Document<DocumentMetadata>[]> {
    try {
      this.storeManager.checkInitialized();

      const cleanedQuery = query.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!cleanedQuery) {
        Logger.warn('Empty query after cleaning');
        return [];
      }

      Logger.info(
        `Performing similarity search for query: "${cleanedQuery.substring(0, 50)}${cleanedQuery.length > 50 ? '...' : ''}" with k=${k}`,
      );

      const searchService = this.storeManager.getSearchService();
      if (!searchService) {
        Logger.error('Search service is not initialized');
        return [];
      }

      const results = await searchService.similaritySearch(cleanedQuery, k);
      Logger.info(`Search found ${results.length} results`);

      if (results.length === 0) {
        Logger.warn(
          `No results found for query: "${cleanedQuery.substring(0, 50)}${cleanedQuery.length > 50 ? '...' : ''}"`,
        );
      }

      return results;
    } catch (error) {
      Logger.error('Error performing similarity search', error as Error);
      return [];
    }
  }

  /**
   * 캐시에서 벡터 스토어 초기화 시도 (GitHub API 호출 없이)
   */
  public async initializeFromCacheOnly(owner: string, repo: string): Promise<boolean> {
    try {
      Logger.info(`Attempting to initialize vector store from cache only: ${owner}/${repo}`);
      
      const cacheFilePath = this.cacheManager.getCacheFilePath(owner, repo);
      
      // 캐시 파일이 존재하는지 확인
      if (!require('fs').existsSync(cacheFilePath)) {
        Logger.info(`No cache file found at ${cacheFilePath}`);
        return false;
      }
      
      // 캐시 로드 시도 (파일 검증 없이)
      const cacheData = await this.cacheManager.loadEmbeddingsCache(cacheFilePath, []);
      
      if (!cacheData) {
        Logger.info('Cache data is invalid or corrupted');
        return false;
      }
      
      Logger.info(`Found cached data with ${cacheData.documents.length} documents`);
      
      // 캐시된 문서 트리 복원
      const markdownFiles: MarkdownFile[] = [];
      if (cacheData.documentTrees) {
        for (const [fileName, tree] of cacheData.documentTrees.entries()) {
          markdownFiles.push({
            name: fileName,
            path: fileName,
            content: '', // 캐시에서 로드할 때는 전체 내용 불필요
            githubUrl: `https://github.com/${owner}/${repo}/blob/main/${fileName}`,
            tree: tree
          });
        }
      }
      
      this.markdownFiles = markdownFiles;
      
      // 벡터 스토어 초기화
      const success = await this.storeManager.initializeStore(cacheData.documents, cacheData.embeddings);
      
      if (success) {
        Logger.info(`Successfully initialized vector store from cache with ${cacheData.documents.length} documents`);
        return true;
      } else {
        Logger.error('Failed to initialize vector store from cache');
        return false;
      }
    } catch (error) {
      Logger.error('Error initializing from cache only', error as Error);
      return false;
    }
  }

  /**
   * 메시지 기반 스마트 검색
   */
  public async smartSearchForMessages(messages: SlackMessage[], k = 5): Promise<Document<DocumentMetadata>[]> {
    this.storeManager.checkInitialized();

    const enhancedSearchService = this.storeManager.getEnhancedSearchService();
    if (!enhancedSearchService) {
      Logger.warn('Enhanced search service not initialized, falling back to basic search');
      const query = messages.map((msg) => msg.text).join('\n');
      return await this.similaritySearch(query, k);
    }

    return await enhancedSearchService.performEnhancedSearch(messages, k);
  }

  // Getter methods for compatibility
  public getMarkdownFile(fileName: string): MarkdownFile | undefined {
    return this.markdownFiles.find((file) => file.name === fileName);
  }

  public getAllMarkdownFiles(): MarkdownFile[] {
    return this.markdownFiles;
  }

  public isHealthy(): boolean {
    const diagnosis = this.storeManager.getDiagnostics();
    return diagnosis.status === 'healthy';
  }

  public get vectorCount(): number {
    const diagnosis = this.storeManager.getDiagnostics();
    return diagnosis.details.vectorsCount;
  }

  public diagnoseVectorStore() {
    return this.storeManager.getDiagnostics();
  }

  /**
   * 벡터 스토어 설정 및 초기화 (기존 인터페이스 호환)
   */
  public async setMarkdownFiles(
    markdownFiles: MarkdownFile[],
    options?: { owner: string; repo: string },
  ): Promise<void> {
    Logger.info(`Setting markdown files: ${markdownFiles.length} files found`);

    const success = await this.initialize(markdownFiles);

    if (!success) {
      Logger.error('Failed to initialize vector store with markdown files');
      throw new VectorStoreError('Failed to initialize vector store', {
        code: ErrorCodes.VECTOR_STORE_INITIALIZATION_FAILED,
      });
    }

    Logger.info('Successfully set markdown files and initialized vector store');
  }

  /**
   * 벡터 스토어 리셋 및 재구축
   */
  public async resetAndRebuildVectorStore(): Promise<boolean> {
    Logger.info('Resetting and rebuilding vector store');

    this.storeManager.reset();

    // 현재 작업 중인 repository의 캐시만 무효화
    if (this.markdownFiles.length > 0) {
      const firstFile = this.markdownFiles[0];
      if (firstFile && firstFile.githubUrl) {
        const match = firstFile.githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (match && match.length >= 3) {
          const owner = match[1];
          const repo = match[2];
          Logger.info(`Invalidating cache only for repository: ${owner}/${repo}`);
          await this.cacheManager.invalidateCacheForRepository(owner, repo);
        } else {
          Logger.warn('Could not extract repository info, invalidating all cache');
          await this.cacheManager.invalidateCache();
        }
      } else {
        Logger.warn('No GitHub URL found, invalidating all cache');
        await this.cacheManager.invalidateCache();
      }

      return await this.initialize(this.markdownFiles, true, true);
    }

    Logger.warn('No markdown files available to rebuild vector store');
    return false;
  }

  /**
   * 단일 파일 업데이트
   */
  public async updateSingleFile(updatedFile: MarkdownFile): Promise<boolean> {
    // 이 메서드는 복잡하므로 기존 구현을 유지하고 필요시 별도 리팩토링
    Logger.warn('updateSingleFile method needs implementation in refactored service');
    return false;
  }

  /**
   * 새로운 섹션 추가
   */
  public async addNewSection(fileName: string, sectionTitle: string, sectionBody: string): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      // 1. 트리에 새 섹션 추가하고 새 노드 ID들 가져오기
      const beforeNodeCount = file.tree.nodeMap.size;
      file.tree = createNewSectionNode(file.tree, sectionTitle, sectionBody);
      const afterNodeCount = file.tree.nodeMap.size;

      Logger.info(`Added new section "${sectionTitle}" to ${fileName}`);

      // 2. 새로 추가된 노드들만 증분 업데이트
      if (afterNodeCount > beforeNodeCount) {
        Logger.info('Performing incremental vector store update for new section');

        // 간단한 증분 업데이트: 전체 파일을 다시 처리하되 캐시된 웹 콘텐츠는 유지
        const success = await this.updateSingleFileInVectorStore(file);
        if (!success) {
          Logger.warn('Failed to update vector store incrementally, but tree was updated');
          return false;
        }

        Logger.info('Successfully updated vector store with new section');
      }

      return true;
    } catch (error) {
      Logger.error('Error adding new section', error as Error);
      return false;
    }
  }

  /**
   * 특정 노드에 내용 추가 (증분 업데이트)
   */
  public async appendSpecificNode(fileName: string, nodeId: string, content: string): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      // 1. 트리에 내용 추가
      file.tree = appendNodeContent(file.tree, nodeId, content);
      Logger.info(`Appended content to node ${nodeId} in ${fileName}`);

      // 2. 벡터 스토어 증분 업데이트
      Logger.info('Performing incremental vector store update for appended content');
      const success = await this.updateSingleFileInVectorStore(file);
      if (!success) {
        Logger.warn('Failed to update vector store incrementally, but tree was updated');
        return false;
      }

      return true;
    } catch (error) {
      Logger.error('Error appending to specific node', error as Error);
      return false;
    }
  }

  /**
   * 특정 노드들 업데이트 (증분 업데이트)
   */
  public async updateSpecificNodes(
    fileName: string,
    updates: Array<{ nodeId: string; content: string }>,
  ): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      // 1. 트리에서 모든 노드 업데이트
      for (const update of updates) {
        file.tree = updateNodeContent(file.tree, update.nodeId, update.content);
      }

      Logger.info(`Updated ${updates.length} nodes in ${fileName}`);

      // 2. 벡터 스토어 증분 업데이트
      Logger.info('Performing incremental vector store update for updated nodes');
      const success = await this.updateSingleFileInVectorStore(file);
      if (!success) {
        Logger.warn('Failed to update vector store incrementally, but tree was updated');
        return false;
      }

      return true;
    } catch (error) {
      Logger.error('Error updating specific nodes', error as Error);
      return false;
    }
  }

  /**
   * 캐시 매니저 반환
   */
  public getCacheManager() {
    return this.cacheManager;
  }

  /**
   * 저장소 정보 추출
   */
  public extractRepoInfoFromFiles() {
    const firstFile = this.markdownFiles[0];
    if (!firstFile?.githubUrl) return null;

    const match = firstFile.githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (match && match.length >= 3) {
      return {
        owner: match[1],
        repo: match[2],
        path: '',
        url: `https://github.com/${match[1]}/${match[2]}`,
      };
    }
    return null;
  }

  /**
   * 향상된 검색 (기존 호환성)
   */
  public async enhancedSearch(query: string, k = 5): Promise<any[]> {
    return await this.similaritySearch(query, k);
  }

  // ===== 증분 업데이트 메서드들 =====

  /**
   * 단일 노드를 증분으로 벡터 스토어에 추가
   */
  public async addNodeIncremental(
    fileName: string,
    nodeId: string,
    nodeContent: string,
    nodeType: 'paragraph' | 'listItem' | 'code' | 'blockquote' = 'paragraph',
  ): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      // 1. 노드에서 Document 생성
      const documents = await this.createDocumentsFromSingleNode(file, nodeId, nodeContent, nodeType);
      if (documents.length === 0) {
        Logger.warn(`No documents generated for node ${nodeId}`);
        return true; // 빈 노드는 성공으로 처리
      }

      // 2. 웹 콘텐츠 향상 (새 노드에만 적용)
      const enhancedDocuments = await this.enhanceNewDocuments(documents);

      // 3. 임베딩 생성 및 벡터 스토어에 추가
      const success = await this.addDocumentsToVectorStore(enhancedDocuments);
      if (!success) {
        Logger.error(`Failed to add documents to vector store for node ${nodeId}`);
        return false;
      }

      // 4. 노드별 Document 맵에 저장
      this.nodeDocumentMap.set(nodeId, enhancedDocuments);

      Logger.info(`Successfully added node ${nodeId} to vector store incrementally`);
      return true;
    } catch (error) {
      Logger.error(`Error adding node ${nodeId} incrementally`, error as Error);
      return false;
    }
  }

  /**
   * 단일 노드를 증분으로 업데이트 (기존 제거 후 새로 추가)
   */
  public async updateNodeIncremental(
    fileName: string,
    nodeId: string,
    newContent: string,
    nodeType: 'paragraph' | 'listItem' | 'code' | 'blockquote' = 'paragraph',
  ): Promise<boolean> {
    try {
      // 1. 기존 노드의 Document들 제거
      await this.removeNodeFromVectorStore(nodeId);

      // 2. 새 내용으로 노드 추가
      return await this.addNodeIncremental(fileName, nodeId, newContent, nodeType);
    } catch (error) {
      Logger.error(`Error updating node ${nodeId} incrementally`, error as Error);
      return false;
    }
  }

  /**
   * 벡터 스토어에서 특정 노드의 Document들 제거
   */
  private async removeNodeFromVectorStore(nodeId: string): Promise<void> {
    try {
      const existingDocuments = this.nodeDocumentMap.get(nodeId);
      if (existingDocuments && existingDocuments.length > 0) {
        // 실제 벡터 스토어에서 Document 제거
        const success = await this.storeManager.removeDocuments(existingDocuments);
        if (!success) {
          Logger.error(`Failed to remove documents for node ${nodeId} from vector store`);
          throw new Error(`Failed to remove documents for node ${nodeId}`);
        }

        // 맵에서도 제거
        this.nodeDocumentMap.delete(nodeId);

        Logger.info(`Successfully removed ${existingDocuments.length} documents for node ${nodeId} from vector store`);
      }
    } catch (error) {
      Logger.error(`Error removing node ${nodeId} from vector store`, error as Error);
      throw error;
    }
  }

  /**
   * 단일 노드에서 Document 생성
   */
  private async createDocumentsFromSingleNode(
    file: MarkdownFile,
    nodeId: string,
    nodeContent: string,
    nodeType: string,
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      Logger.info(`Creating documents for single node ${nodeId} (type: ${nodeType})`);

      // 단일 Document 생성
      const document = new Document({
        pageContent: nodeContent,
        metadata: {
          fileName: file.name,
          nodeId: nodeId,
          sectionId: `section_${nodeId}`,
          sectionName: undefined, // 실제 섹션 이름은 트리에서 가져와야 함
          nodeType: nodeType,
          githubUrl: file.githubUrl,
          headingPath: [], // 실제 경로는 트리에서 계산해야 함
          ancestors: [],
          depth: 0,
          importance: 0.5, // 기본 중요도
          entityMentions: this.extractSimpleEntities(nodeContent),
        },
      });

      Logger.info(`Successfully created document for node ${nodeId}`);
      return [document];
    } catch (error) {
      Logger.error(`Error creating documents from single node ${nodeId}`, error as Error);
      return [];
    }
  }

  /**
   * 간단한 엔티티 추출 (키워드 기반)
   */
  private extractSimpleEntities(text: string): string[] {
    try {
      // 간단한 키워드 추출
      const words = text.match(/\b[A-Za-z0-9_]{3,}\b/g) || [];
      const stopwords = new Set(['the', 'and', 'or', 'but', 'is', 'are', 'in', 'to', 'for', 'of', 'with', 'on', 'at']);

      return [...new Set(words)].filter((word) => !stopwords.has(word.toLowerCase())).slice(0, 10); // 최대 10개
    } catch (error) {
      Logger.error('Error extracting entities', error as Error);
      return [];
    }
  }

  /**
   * 새로운 Document들에만 웹 콘텐츠 향상 적용
   */
  private async enhanceNewDocuments(documents: Document<DocumentMetadata>[]): Promise<Document<DocumentMetadata>[]> {
    try {
      const isWebContentEnabled = process.env.ENABLE_WEB_CONTENT === 'true';

      if (!isWebContentEnabled) {
        Logger.info('Skipping web content enhancement for new documents');
        return documents;
      }

      const { DocumentEnhancer } = await import('../web-content/document-enhancer');
      const enhancer = DocumentEnhancer.getInstance();

      return await enhancer.enhanceDocuments(documents);
    } catch (error) {
      Logger.error('Error enhancing new documents', error as Error);
      return documents; // 실패 시 원본 반환
    }
  }

  /**
   * Document들을 벡터 스토어에 추가
   */
  private async addDocumentsToVectorStore(documents: Document<DocumentMetadata>[]): Promise<boolean> {
    try {
      if (documents.length === 0) {
        return true;
      }

      // 텍스트 추출 및 임베딩 생성
      const texts = this.documentProcessor.prepareTextsForEmbedding(documents);
      const embeddings = await this.embeddingService.createEmbeddings(texts);

      if (!embeddings || embeddings.length === 0) {
        Logger.error('Failed to create embeddings for new documents');
        return false;
      }

      // 실제 증분 추가
      Logger.info('Adding documents using incremental update');
      const success = await this.storeManager.addDocuments(documents, embeddings);
      if (!success) {
        Logger.error('Failed to add documents to vector store incrementally');
        return false;
      }

      Logger.info(`Successfully added ${documents.length} documents to vector store incrementally`);
      return true;
    } catch (error) {
      Logger.error('Error adding documents to vector store', error as Error);
      return false;
    }
  }

  /**
   * 단일 파일의 벡터 스토어 업데이트 (최적화된 방식)
   */
  private async updateSingleFileInVectorStore(file: MarkdownFile): Promise<boolean> {
    try {
      Logger.info(`Updating vector store for file: ${file.name}`);

      // 현재는 전체 재빌드 사용, 향후 개선 가능
      // TODO: 실제 증분 업데이트 구현
      return await this.resetAndRebuildVectorStore();
    } catch (error) {
      Logger.error(`Error updating vector store for file ${file.name}`, error as Error);
      return false;
    }
  }
}
