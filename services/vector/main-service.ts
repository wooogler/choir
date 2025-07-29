import { Document } from '@langchain/core/documents';
import { Logger } from '../common/logger';
import { DocumentTree } from '../document';
import { updateNodeContent } from '../document/markdown';
import type { MarkdownFile } from '../github';
import type { SlackMessage } from '../slack';
import { VectorCacheManager } from './cache-manager';
import { DocumentProcessor } from './document-processor';
import { EmbeddingService } from './embedding-service';
import { FAISSStoreManager } from './faiss-store-manager';
import { VectorStoreError } from './types';
import type { DocumentMetadata } from './types';

/**
 * 벡터 스토어 서비스 - FAISS 기반
 * 문서 임베딩, 캐싱, 검색 기능을 제공하는 통합 서비스
 */
export class VectorStoreService {
  private static instance: VectorStoreService;

  private embeddingService: EmbeddingService;
  private cacheManager: VectorCacheManager;
  private storeManager: FAISSStoreManager;
  private documentProcessor: DocumentProcessor;
  private markdownFiles: MarkdownFile[] = [];
  private cacheId = '';

  // 노드 ID와 문서 매핑 (증분 업데이트용)
  private nodeDocumentMap = new Map<string, Document<DocumentMetadata>[]>();

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
    this.documentProcessor = new DocumentProcessor();
    this.cacheManager = new VectorCacheManager();

    // FAISS 사용 (안정적이고 빠른 벡터 검색, 파일별 인덱싱)
    this.storeManager = new FAISSStoreManager(this.embeddingService);
    Logger.info('Using FAISS vector store (stable and fast, file-based indexing)');
  }

  public static getInstance(embeddingService?: EmbeddingService): VectorStoreService {
    if (!VectorStoreService.instance) {
      if (!embeddingService) {
        embeddingService = new EmbeddingService();
      }
      VectorStoreService.instance = new VectorStoreService(embeddingService);
    }
    return VectorStoreService.instance;
  }

  /**
   * 벡터 스토어 초기화
   */
  public async initialize(markdownFiles: MarkdownFile[], useCache = true, forceRefresh = false, workspaceId?: string): Promise<boolean> {
    Logger.info(
      `Initializing Vector Store with ${markdownFiles.length} files (useCache=${useCache}, forceRefresh=${forceRefresh})`,
    );

    try {
      this.markdownFiles = markdownFiles;

      if (!this.markdownFiles.length) {
        Logger.info('No documents loaded, starting with empty vector store');
        return await this.storeManager.initializeStore([], [], workspaceId);
      }

      this.cacheId = this.cacheManager.generateCacheId();
      const buildSuccess = await this.buildVectorStore(this.markdownFiles, useCache, forceRefresh, workspaceId);

      if (!buildSuccess) {
        Logger.error('Failed to build vector store');
        return false;
      }

      Logger.info(`VectorStoreService: Ready with ${this.storeManager.getDocuments().length} documents`);
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
    workspaceId?: string,
  ): Promise<boolean> {
    try {
      Logger.info(`Building vector store (useCache=${useCache}, forceRefresh=${forceRefresh})`);

      if (!useCache || forceRefresh) {
        return await this.buildVectorStoreFromFiles(markdownFiles, workspaceId);
      }

      const isCacheValid = await this.cacheManager.validateCache(markdownFiles);

      if (isCacheValid) {
        Logger.info('Valid cache found, loading from cache');
        return await this.restoreFromCache(workspaceId);
      }

      Logger.info('No valid cache found, building from files');
      return await this.buildVectorStoreFromFiles(markdownFiles, workspaceId);
    } catch (error) {
      Logger.error('Error building vector store', error as Error);
      return false;
    }
  }

  /**
   * 파일로부터 벡터 스토어 구축
   */
  private async buildVectorStoreFromFiles(markdownFiles: MarkdownFile[], workspaceId?: string): Promise<boolean> {
    try {
      Logger.info(`Building vector store from ${markdownFiles.length} files`);

      // 새로 빌드할 때는 nodeDocumentMap도 초기화
      Logger.info('Clearing nodeDocumentMap for fresh build');
      this.nodeDocumentMap.clear();

      const documents = await this.documentProcessor.prepareDocuments(markdownFiles);
      if (documents.length === 0) {
        Logger.warn('No valid documents found, initializing empty vector store');
        return await this.storeManager.initializeStore([], [], workspaceId);
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

      return await this.storeManager.initializeStore(documents, embeddings, workspaceId);
    } catch (error) {
      Logger.error('Error building vector store from files', error as Error);
      return false;
    }
  }

  /**
   * 캐시에서 벡터 스토어 복원
   */
  private async restoreFromCache(workspaceId?: string): Promise<boolean> {
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

      const success = await this.storeManager.initializeStore(documents, embeddings, workspaceId);

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

      // FAISS 검색 수행
      const results = await this.storeManager.similaritySearch(cleanedQuery, k);
      Logger.info(`FAISS search found ${results.length} results`);

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
   * 특정 파일에 제한된 유사도 검색 수행
   * FAISS 스토어의 내장 필터링 기능 사용
   */
  public async similaritySearchByFile(query: string, filePath: string, k = 1): Promise<Document<DocumentMetadata>[]> {
    try {
      this.storeManager.checkInitialized();

      const cleanedQuery = query.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!cleanedQuery) {
        Logger.warn('Empty query after cleaning');
        return [];
      }

      Logger.info(
        `Performing file-specific similarity search for query: "${cleanedQuery.substring(0, 50)}${cleanedQuery.length > 50 ? '...' : ''}" in file: ${filePath} with k=${k}`,
      );

      // Extract filename for filter (support both full path and basename)
      const fileName = filePath.split('/').pop() || filePath;

      // Use FAISS store's built-in file filtering
      const results = await this.storeManager.similaritySearchByFile(cleanedQuery, fileName, k);

      Logger.info(`File-specific search returned ${results.length} results for file: ${fileName}`);

      // Debug: Log file-specific results
      if (results.length > 0) {
        console.log('=== FILE-SPECIFIC SEARCH RESULTS ===');
        console.log(`Target file: ${filePath} (filter: ${fileName})`);
        console.log(`Results found: ${results.length}`);
        results.forEach((doc, index) => {
          console.log(`[${index + 1}] File: ${doc.metadata?.fileName || 'Unknown'}`);
          console.log(`    Section: ${doc.metadata?.sectionName || 'Unknown'}`);
          console.log(`    Content Preview: ${doc.pageContent.substring(0, 100)}...`);
          console.log('---');
        });
        console.log('=== END FILE-SPECIFIC RESULTS ===');
      } else {
        Logger.warn(`No results found for file: ${fileName}`);
      }

      return results;
    } catch (error) {
      Logger.error('Error performing file-specific similarity search', error as Error);
      return [];
    }
  }

  /**
   * 쓰기 가능한 파일들에서만 유사도 검색 수행 (읽기 전용 파일 제외)
   */
  public async similaritySearchWritableFiles(
    query: string,
    workspaceId: string,
    k = 5,
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      this.storeManager.checkInitialized();

      const cleanedQuery = query.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!cleanedQuery) {
        Logger.warn('Empty query after cleaning');
        return [];
      }

      // Get read-only files from workspace config
      const { WorkspaceStore } = await import('services/workspace/workspace-store');
      const workspaceStore = new WorkspaceStore();
      const readOnlyFiles = await workspaceStore.getReadOnlyFiles(workspaceId);

      Logger.info(
        `Performing writable files similarity search for query: "${cleanedQuery.substring(0, 50)}${cleanedQuery.length > 50 ? '...' : ''}" with k=${k}, excluding ${readOnlyFiles.length} read-only files`,
      );

      const results = await this.storeManager.similaritySearchWritableFiles(cleanedQuery, readOnlyFiles, k);

      Logger.info(`Writable files search returned ${results.length} results`);

      if (readOnlyFiles.length > 0) {
        Logger.info(`Excluded read-only files: ${readOnlyFiles.join(', ')}`);
      }

      return results;
    } catch (error) {
      Logger.error('Error performing writable files similarity search', error as Error);
      return [];
    }
  }

  /**
   * 읽기 전용 파일 설정 변경 시 쓰기 가능한 파일 인덱스 업데이트
   */
  public async updateReadOnlyFilesConfiguration(workspaceId: string): Promise<boolean> {
    try {
      this.storeManager.checkInitialized();

      // Get read-only files from workspace config
      const { WorkspaceStore } = await import('services/workspace/workspace-store');
      const workspaceStore = new WorkspaceStore();
      const readOnlyFiles = await workspaceStore.getReadOnlyFiles(workspaceId);

      Logger.info(
        `Updating read-only files configuration for workspace ${workspaceId}, ${readOnlyFiles.length} files set as read-only`,
      );

      const success = await this.storeManager.updateReadOnlyFiles(readOnlyFiles);

      if (success) {
        Logger.info('Successfully updated writable files index configuration');
      } else {
        Logger.error('Failed to update writable files index configuration');
      }

      return success;
    } catch (error) {
      Logger.error('Error updating read-only files configuration', error as Error);
      return false;
    }
  }

  /**
   * 캐시에서 벡터 스토어 초기화 시도 (GitHub API 호출 없이)
   */
  public async initializeFromCacheOnly(owner: string, repo: string, workspaceId?: string): Promise<boolean> {
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
            tree: tree,
          });
        }
      }

      this.markdownFiles = markdownFiles;

      // 벡터 스토어 초기화
      const success = await this.storeManager.initializeStore(cacheData.documents, cacheData.embeddings, workspaceId);

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

    // Enhanced search 서비스가 제거되었으므로 기본 검색 사용
    Logger.info('Using basic similarity search for messages');
    const query = messages.map((msg) => msg.text).join('\n');
    return await this.similaritySearch(query, k);
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
  /**
   * 마크다운 파일 배열에 새 파일 추가
   */
  public addToMarkdownFiles(markdownFile: MarkdownFile): void {
    this.markdownFiles.push(markdownFile);
    Logger.info(`Added new file to markdownFiles array: ${markdownFile.name}`);
  }

  public async setMarkdownFiles(
    markdownFiles: MarkdownFile[],
    options?: { owner: string; repo: string; workspaceId?: string },
  ): Promise<void> {
    Logger.info(`Setting markdown files: ${markdownFiles.length} files found`);

    const success = await this.initialize(markdownFiles, true, false, options?.workspaceId);

    if (!success) {
      Logger.error('Failed to initialize vector store with markdown files');
      throw new Error('Failed to initialize vector store'); // Assuming a specific error type
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
      const { createNewSectionNode } = await import('../document/markdown');
      const result = createNewSectionNode(file.tree, sectionTitle, sectionBody);
      file.tree = result.tree;
      const newNodeIds = result.newNodeIds;

      Logger.info(`Added new section "${sectionTitle}" to ${fileName}`);

      // 2. 새로 생성된 노드들만 정확하게 벡터 스토어에 추가
      Logger.info(`Performing incremental vector store update for new section: ${newNodeIds.length} new nodes`);

      let successCount = 0;
      for (const nodeId of newNodeIds) {
        const node = file.tree.nodeMap.get(nodeId);
        if (node) {
          // toString을 사용해서 노드 내용 추출
          const { toString } = await import('mdast-util-to-string');
          const nodeContent = toString(node);
          if (nodeContent && nodeContent.trim()) {
            const success = await this.addNodeIncremental(fileName, nodeId, nodeContent, node.type as any);
            if (success) successCount++;
          }
        }
      }

      Logger.info(`Successfully added ${successCount}/${newNodeIds.length} new nodes to vector store`);
      if (successCount < newNodeIds.length) {
        Logger.warn('Some nodes failed to be added to vector store');
      }

      return true;
    } catch (error) {
      Logger.error('Error adding new section', error as Error);
      return false;
    }
  }

  /**
   * 특정 노드를 새로운 내용으로 교체 (enhanceExistingContent용) - 여러 listItem/paragraph 지원
   * 예: 기존 "- A is B" → 새로운 "- A is C\n- B is C" (1개 노드 → 2개 노드로 교체)
   */
  public async replaceNodeWithEnhancedContent(fileName: string, nodeId: string, content: string): Promise<boolean> {
    try {
      const file = this.getMarkdownFile(fileName);
      if (!file) {
        Logger.error(`File not found: ${fileName}`);
        return false;
      }

      let addedCount = 0; // Declare at method scope

      // Import 함수들
      const { parseAndSplitContent, createReplacementNodes, replaceNodeAtomically } = await import(
        '../document/markdown'
      );


      // 1. content를 파싱하여 개별 항목들로 분할
      const contentItems = parseAndSplitContent(content);
      Logger.info(
        `Parsed content into ${contentItems.length} items:`,
        contentItems.map((item) => `${item.type}: "${item.content.substring(0, 30)}..."`),
      );

      // 2. 기존 노드 목록 저장 (새 노드 감지용)
      const existingNodeIds = new Set(file.tree.nodeMap.keys());

      // 3. Atomic replacement 로직 사용
      const originalNode = file.tree.nodeMap.get(nodeId);
      
      if (originalNode) {
        Logger.info(`Using atomic replacement for node ${nodeId}`);
        
        // 기존 노드를 벡터 스토어에서 제거
        await this.removeNodeFromVectorStore(nodeId);
        Logger.info(`Removed existing node ${nodeId} from vector store`);
        
        // 원자적 노드 교체
        const replacementNodes = createReplacementNodes(originalNode, contentItems);
        file.tree = replaceNodeAtomically(file.tree, nodeId, replacementNodes);
        Logger.info(`Atomically replaced node ${nodeId} with ${replacementNodes.length} replacement nodes`);

        // 새로 추가된 노드들을 벡터 스토어에 추가
        Logger.info('Adding replacement nodes to vector store');
        const { toString } = await import('mdast-util-to-string');

        // 새로 추가된 노드들을 정확하게 찾기 (기존 노드 목록과 비교)
        const allNodes = Array.from(file.tree.nodeMap.entries());
        const newNodes = allNodes.filter(([newNodeId]) => {
          // 기존에 없던 노드들만 선택
          return !existingNodeIds.has(newNodeId);
        });

        Logger.info(`Found ${newNodes.length} new nodes to add to vector store`);

        for (const [newNodeId, newNode] of newNodes) {
          // 이미 벡터 스토어에 있는 노드는 건너뛰기
          if (this.nodeDocumentMap.has(newNodeId)) {
            continue;
          }

          try {
            const newNodeContent = toString(newNode);
            if (newNodeContent && newNodeContent.trim()) {
              const success = await this.addNodeIncremental(fileName, newNodeId, newNodeContent, newNode.type as any);
              if (success) {
                addedCount++;
                Logger.info(`Successfully added replacement node ${newNodeId} to vector store`);
              } else {
                Logger.warn(`Failed to add replacement node ${newNodeId} to vector store`);
              }
            }
          } catch (error) {
            Logger.error(`Error adding replacement node ${newNodeId} to vector store:`, error as Error);
          }
        }

        Logger.info(`Successfully added ${addedCount}/${newNodes.length} replacement nodes to vector store`);
      } else {
        Logger.warn(`No content items found in enhanced content: "${content}"`);
        return false;
      }

      Logger.info(
        `Node replacement completed successfully: removed 1 original node, added ${addedCount} replacement nodes`,
      );
      

      
      return true;
    } catch (error) {
      Logger.error('Error replacing node with enhanced content', error as Error);
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

      // 2. 벡터 스토어 노드 단위 증분 업데이트
      Logger.info('Performing node-level incremental vector store update for updated nodes');

      let successCount = 0;
      for (const update of updates) {
        const updatedNode = file.tree.nodeMap.get(update.nodeId);
        if (updatedNode) {
          const { toString } = await import('mdast-util-to-string');
          const updatedNodeContent = toString(updatedNode);

          const success = await this.updateNodeIncremental(
            fileName,
            update.nodeId,
            updatedNodeContent,
            updatedNode.type as any,
          );
          if (success) {
            successCount++;
            Logger.info(`Successfully updated node ${update.nodeId} in vector store`);
          } else {
            Logger.error(`Failed to update node ${update.nodeId} in vector store`);
          }
        } else {
          Logger.error(`Could not find updated node ${update.nodeId} in tree`);
        }
      }

      if (successCount < updates.length) {
        Logger.warn(`Only ${successCount}/${updates.length} nodes were successfully updated in vector store`);
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

      // 헤딩 노드는 벡터 스토어에 추가하지 않음 (기존 로직과 일치)
      if (nodeType === 'heading') {
        Logger.info(`Skipping heading node ${nodeId} - headings are not added to vector store`);
        return [];
      }

      // 트리에서 노드 찾기
      const node = file.tree.nodeMap.get(nodeId);
      if (!node) {
        Logger.warn(`Node ${nodeId} not found in tree for ${file.name}`);
        return [];
      }

      // 헤딩 경로와 섹션 정보 구하기
      const { formatHeadingContext, getHeadingPathForNode, getSectionName, buildParentChildMap, getAncestorNodes } =
        await import('../llm/langchain');

      // 부모-자식 관계 맵 구축
      const nodeParentMap = buildParentChildMap(file.tree);

      // 헤딩 맵 구축
      const headingMap = new Map<string, string>();
      const { visit } = await import('unist-util-visit');
      const { toString } = await import('mdast-util-to-string');

      visit(file.tree.root, 'heading', (headingNode: any) => {
        if (headingNode.sectionId && headingNode.id) {
          const headingText = toString(headingNode);
          headingMap.set(headingNode.sectionId, headingText);
        }
      });

      // 섹션별 헤딩 노드 수집
      const sectionToHeadings = new Map<string, any[]>();
      visit(file.tree.root, 'heading', (headingNode: any) => {
        if (headingNode.sectionId && headingNode.id) {
          if (!sectionToHeadings.has(headingNode.sectionId)) {
            sectionToHeadings.set(headingNode.sectionId, []);
          }
          sectionToHeadings.get(headingNode.sectionId)!.push(headingNode);
        }
      });

      // 노드의 조상 노드들 찾기
      const ancestors = getAncestorNodes(node, nodeParentMap);

      // 헤딩 경로 구성
      const headingPath = getHeadingPathForNode(node, ancestors, headingMap, sectionToHeadings);

      // 계층적 문맥 구성 (마크다운 헤더 형태: # filename, ## section)
      const contextPrefix = formatHeadingContext(headingPath, file.name);

      // 섹션 이름 가져오기
      const { sectionName } = getSectionName(node, headingMap);

      // 올바른 형태의 pageContent 구성
      const fullContent = `${contextPrefix}${nodeContent}`;

      // 단일 Document 생성
      const document = new Document({
        pageContent: fullContent,
        metadata: {
          fileName: file.name,
          nodeId: nodeId,
          sectionId: node.sectionId,
          sectionName: sectionName,
          nodeType: nodeType,
          githubUrl: file.githubUrl || '',
          headingPath: headingPath.join(' > '), // 배열을 문자열로 변환
          originalContent: nodeContent, // 컨텍스트 제외한 원본 내용 저장
        },
      });

      // DEBUG: Document 내용 로그 출력
      Logger.info(`📄 Created document for node ${nodeId}:`);
      Logger.info(`   📝 PageContent: "${fullContent.substring(0, 200)}..."`);
      Logger.info(`   🏷️  FileName: ${file.name}`);
      Logger.info(`   🆔 NodeId: ${nodeId}`);
      Logger.info(`   📂 SectionName: ${sectionName || 'undefined'}`);
      Logger.info(`   🧭 HeadingPath: ${headingPath.join(' > ')}`);
      Logger.info(`   🔗 NodeType: ${nodeType}`);

      Logger.info(`Successfully created document for node ${nodeId}`);
      return [document];
    } catch (error) {
      Logger.error(`Error creating documents from single node ${nodeId}`, error as Error);
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
   * 단일 문서를 벡터 스토어에 추가
   */
  public async addDocument(fileName: string, content: string, metadata: DocumentMetadata): Promise<boolean> {
    try {
      Logger.info(`Adding single document to vector store: ${fileName}`);

      // 기존 파일 처리 로직을 재사용하여 MarkdownFile 객체 생성
      const markdownFile: MarkdownFile = {
        name: fileName,
        path: metadata.fileName || fileName,
        content: content,
        githubUrl: metadata.githubUrl,
        tree: {} as any, // 임시로 빈 객체, 아래에서 설정
      };

      // parseMarkdownToTree를 사용하여 트리 생성
      const { parseMarkdownToTree } = await import('../document/markdown');
      markdownFile.tree = parseMarkdownToTree(content);

      // createDocumentsFromTree를 사용하여 Document 배열 생성
      const { createDocumentsFromTree } = await import('../llm');
      const documents = createDocumentsFromTree(markdownFile.tree, markdownFile.name, markdownFile.githubUrl);

      if (documents.length === 0) {
        Logger.warn(`No content found in document: ${fileName}`);
        return true;
      }

      // 기존 addDocumentsToVectorStore 메서드 사용
      const success = await this.addDocumentsToVectorStore(documents);

      if (success) {
        // markdownFiles 배열에도 추가하여 캐시에 포함
        this.markdownFiles.push(markdownFile);
        Logger.info(`Successfully added single document ${fileName} with ${documents.length} nodes to vector store`);
      } else {
        Logger.error(`Failed to add single document ${fileName} to vector store`);
      }

      return success;
    } catch (error) {
      Logger.error(`Error adding single document ${fileName} to vector store`, error as Error);
      return false;
    }
  }

  /**
   * Document들을 벡터 스토어에 추가
   */
  public async addDocumentsToVectorStore(documents: Document<DocumentMetadata>[]): Promise<boolean> {
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
}
