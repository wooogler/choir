import type { Document } from '@langchain/core/documents';
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

  private constructor(openAIApiKey: string = process.env.AZURE_OPENAI_API_KEY || '') {
    this.embeddingService = new EmbeddingService(openAIApiKey);
    this.cacheManager = new VectorCacheManager();
    this.storeManager = new VectorStoreManager(this.embeddingService);
    this.documentProcessor = new DocumentProcessor();

    Logger.info('VectorStoreService instance created with Azure OpenAI');
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
        Logger.warn('No markdown files provided, initializing empty vector store');
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
    await this.cacheManager.invalidateCache();

    if (this.markdownFiles.length > 0) {
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

      file.tree = createNewSectionNode(file.tree, sectionTitle, sectionBody);

      Logger.info(`Added new section "${sectionTitle}" to ${fileName}`);
      return true;
    } catch (error) {
      Logger.error('Error adding new section', error as Error);
      return false;
    }
  }

  /**
   * 특정 노드에 내용 추가
   */
  public async appendSpecificNode(fileName: string, nodeId: string, content: string): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      file.tree = appendNodeContent(file.tree, nodeId, content);
      Logger.info(`Appended content to node ${nodeId} in ${fileName}`);
      return true;
    } catch (error) {
      Logger.error('Error appending to specific node', error as Error);
      return false;
    }
  }

  /**
   * 특정 노드들 업데이트
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

      for (const update of updates) {
        file.tree = updateNodeContent(file.tree, update.nodeId, update.content);
      }

      Logger.info(`Updated ${updates.length} nodes in ${fileName}`);
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
   * 강제 캐시 재빌드
   */
  public async forceRebuildCache(): Promise<boolean> {
    return await this.resetAndRebuildVectorStore();
  }

  /**
   * 향상된 검색 (기존 호환성)
   */
  public async enhancedSearch(query: string, k = 5): Promise<any[]> {
    return await this.similaritySearch(query, k);
  }
}
