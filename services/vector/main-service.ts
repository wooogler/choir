import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MarkdownFile } from "../github";
import { VectorCacheManager } from "./cache-manager";
import { EmbeddingService } from "./embedding-service";
import { SearchService } from "./search-service";
import { DocumentMetadata, VectorStoreError } from "./types";
import { DocumentTree } from "services/document";
import { createDocumentsFromTree } from "services/llm";
import { DocumentEnhancer } from "services/web-content/document-enhancer";
import { preprocessMarkdownForEmbedding } from "services/document/markdown";
import { EnhancedSearchService } from "./enhanced-search";
import { SlackMessage } from "services/slack";
import { parseMarkdownToTree } from "services/document";
import { formatHeadingContext } from "../llm/langchain";


/**
 * 벡터 스토어의 주요 기능을 담당하는 서비스 클래스
 */
export class VectorStoreService {
  // 싱글톤 인스턴스
  private static instance: VectorStoreService;

  // 주요 서비스 컴포넌트들
  private embeddingService: EmbeddingService;
  private cacheManager: VectorCacheManager;
  private searchService: SearchService;
  private enhancedSearchService: EnhancedSearchService;

  // 상태 관련 필드
  private store: MemoryVectorStore | null = null;
  private isInitialized = false;
  private documents: Document<DocumentMetadata>[] = [];
  private markdownFiles: MarkdownFile[] = [];
  private cacheId: string = "";

  /**
   * 생성자 - 직접 호출하지 않고 getInstance() 메서드를 사용하세요
   */
  private constructor(openAIApiKey: string = process.env.OPENAI_API_KEY || "") {
    // 필요한 서비스 컴포넌트 초기화
    this.embeddingService = new EmbeddingService(openAIApiKey);
    this.cacheManager = new VectorCacheManager();

    // SearchService는 store가 초기화된 후에 생성됨
    this.searchService = null as any;
    this.enhancedSearchService = null as any;

    console.info("VectorStoreService instance created");
  }

  /**
   * 싱글톤 인스턴스 획득
   */
  public static getInstance(): VectorStoreService {
    if (!VectorStoreService.instance) {
      VectorStoreService.instance = new VectorStoreService();
    }
    return VectorStoreService.instance;
  }

  /**
   * 벡터 스토어 초기화
   */
  public async initialize(
    markdownFiles: MarkdownFile[],
    useCache: boolean = true,
    forceRefresh: boolean = false
  ): Promise<boolean> {
    console.info(
      `Initializing Vector Store with ${markdownFiles.length} files (useCache=${useCache}, forceRefresh=${forceRefresh})`
    );

    try {
      this.markdownFiles = markdownFiles;

      // 파일이 없어도 빈 벡터 스토어로 초기화
      if (!this.markdownFiles.length) {
        console.warn(
          "No markdown files provided, initializing empty vector store"
        );
        
        // 빈 벡터 스토어 초기화
        const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
        this.store = new MemoryVectorStore(openAIEmbeddings);
        this.documents = [];
        
        // 빈 검색 서비스 초기화
        this.searchService = new SearchService(this.store, this.embeddingService);
        this.searchService.buildSearchIndices(this.documents);
        this.enhancedSearchService = new EnhancedSearchService(this);
        
        this.isInitialized = true;
        console.info("Successfully initialized empty vector store");
        return true;
      }

      // 캐시 ID 생성
      this.cacheId = this.cacheManager.generateCacheId();

      // 벡터 스토어 빌드
      const buildSuccess = await this.buildVectorStore(
        this.markdownFiles,
        useCache,
        forceRefresh
      );

      if (!buildSuccess) {
        console.error("Failed to build vector store");
        return false;
      }

      this.isInitialized = true;
      console.info(
        `Vector store initialized with ${this.documents.length} documents`
      );
      return true;
    } catch (error) {
      console.error("Failed to initialize vector store", error);
      this.isInitialized = false;
      return false;
    }
  }

  /**
   * 벡터 스토어 구축
   */
  private async buildVectorStore(
    markdownFiles: MarkdownFile[],
    useCache: boolean = true,
    forceRefresh: boolean = false
  ): Promise<boolean> {
    try {
      console.info(
        `Building vector store (useCache=${useCache}, forceRefresh=${forceRefresh})`
      );

      const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();

      // 캐시 사용하지 않거나 강제 리프레시인 경우 새로 구축
      if (!useCache || forceRefresh) {
        return await this.buildVectorStoreFromFiles(
          markdownFiles,
          openAIEmbeddings
        );
      }

      // 캐시 검사
      const isCacheValid = await this.cacheManager.validateCache(markdownFiles);

      // 캐시가 유효하면 캐시에서 복원
      if (isCacheValid) {
        console.info("Valid cache found, loading from cache");
        return await this.restoreFromCache(openAIEmbeddings);
      }

      // 유효한 캐시가 없으면 새로 구축
      console.info("No valid cache found, building from files");
      return await this.buildVectorStoreFromFiles(
        markdownFiles,
        openAIEmbeddings
      );
    } catch (error) {
      console.error("Error building vector store", error);
      return false;
    }
  }

  /**
   * 파일로부터 벡터 스토어 구축
   */
  private async buildVectorStoreFromFiles(
    markdownFiles: MarkdownFile[],
    openAIEmbeddings: OpenAIEmbeddings
  ): Promise<boolean> {
    try {
      console.info(`Building vector store from ${markdownFiles.length} files`);

      // 문서 준비
      this.documents = await this.prepareDocuments(markdownFiles);
      if (this.documents.length === 0) {
        console.warn("No valid documents found, initializing empty vector store");
        // 빈 벡터 스토어 초기화
        const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
        this.store = new MemoryVectorStore(openAIEmbeddings);
        
        // 빈 검색 서비스 초기화
        this.searchService = new SearchService(this.store, this.embeddingService);
        this.searchService.buildSearchIndices(this.documents);
        this.enhancedSearchService = new EnhancedSearchService(this);
        
        console.info("Successfully initialized empty vector store");
        return true;
      }

      // 텍스트 추출 및 임베딩을 위한 전처리
      const texts = this.documents.map((doc) => {
        // 마크다운 링크에서 텍스트만 추출하고 URL 제거
        const preprocessedContent = preprocessMarkdownForEmbedding(doc.pageContent);
        return preprocessedContent;
      });
      console.info(
        `Extracted and preprocessed ${texts.length} text chunks for embedding generation`
      );

      // 전처리 결과 샘플 로깅
      if (texts.length > 0) {
        const originalSample = this.documents[0].pageContent.substring(0, 100);
        const preprocessedSample = texts[0].substring(0, 100);
        console.info(`Preprocessing sample:\nOriginal: "${originalSample}..."\nPreprocessed: "${preprocessedSample}..."`);
      }

      // 임베딩 생성
      const embeddings = await this.embeddingService.createEmbeddings(texts);
      if (!embeddings || embeddings.length === 0) {
        console.error("Failed to create embeddings");
        return false;
      }

      // 문서 트리 수집
      const documentTrees = new Map<string, DocumentTree>();
      markdownFiles.forEach((file) => {
        if (file.tree) {
          documentTrees.set(file.name, file.tree);
        }
      });
      console.info(
        `Collected ${documentTrees.size} document trees for caching`
      );

      // 결과 캐싱
      await this.cacheManager.saveEmbeddingsCache({
        documents: this.documents,
        embeddings,
        contentHash: await this.cacheManager.generateContentHash(markdownFiles),
        timestamp: Date.now(),
        documentTrees, // 문서 트리도 캐시에 저장
      });

      // 메모리 벡터 스토어 생성 및 로드
      this.store = new MemoryVectorStore(openAIEmbeddings);
      const success = await this.embeddingService.loadEmbeddingsToVectorStore(
        this.store,
        this.documents,
        embeddings
      );

      if (!success) {
        console.error("Failed to load embeddings to vector store");
        return false;
      }

      // 검색 서비스 초기화
      this.searchService = new SearchService(this.store, this.embeddingService);
      this.searchService.buildSearchIndices(this.documents);
      this.enhancedSearchService = new EnhancedSearchService(this);

      console.info(
        `Successfully built vector store with ${this.documents.length} documents`
      );
      return true;
    } catch (error) {
      console.error("Error building vector store from files", error);
      return false;
    }
  }

  /**
   * 캐시에서 벡터 스토어 복원
   */
  private async restoreFromCache(
    openAIEmbeddings: OpenAIEmbeddings
  ): Promise<boolean> {
    try {
      console.info("Attempting to restore vector store from cache");

      // 캐시 경로 생성 (첫 번째 마크다운 파일에서 owner, repo 추출)
      const firstFile = this.markdownFiles[0];

      let owner = "default";
      let repo = "default";

      // GitHub URL에서 owner와 repo 정보 추출
      if (firstFile.githubUrl && firstFile.githubUrl.includes("github.com")) {
        const match = firstFile.githubUrl.match(
          /github\.com\/([^\/]+)\/([^\/]+)/
        );
        if (match && match.length >= 3) {
          owner = match[1];
          repo = match[2];
        }
      }

      const cacheFilePath = this.cacheManager.getCacheFilePath(owner, repo);

      // 캐시 상태 로깅
      await this.cacheManager.logCacheStatus(cacheFilePath);

      // 캐시 로드
      const cacheData = await this.cacheManager.loadEmbeddingsCache(
        cacheFilePath,
        this.markdownFiles
      );

      if (!cacheData) {
        console.info("No valid cache data found");
        return false;
      }

      // 캐시된 데이터 로드
      this.documents = cacheData.documents;
      const embeddings = cacheData.embeddings;

      // 캐시된 문서 트리가 있다면 마크다운 파일에 복원
      if (cacheData.documentTrees && cacheData.documentTrees.size > 0) {
        console.info(
          `Found ${cacheData.documentTrees.size} document trees in cache`
        );

        // 파일 이름으로 문서 트리 매핑
        this.markdownFiles.forEach((file) => {
          if (cacheData.documentTrees?.has(file.name)) {
            const cachedTree = cacheData.documentTrees.get(file.name);
            // undefined가 아닌 경우에만 할당
            if (cachedTree) {
              file.tree = cachedTree;
              console.info(`Restored document tree for ${file.name}`);
            }
          }
        });
      }

      // 메모리 벡터 스토어 생성 및 로드
      this.store = new MemoryVectorStore(openAIEmbeddings);
      const success = await this.embeddingService.loadEmbeddingsToVectorStore(
        this.store,
        this.documents,
        embeddings
      );

      if (!success) {
        console.error("Failed to load cached embeddings to vector store");
        return false;
      }

      // 검색 서비스 초기화
      this.searchService = new SearchService(this.store, this.embeddingService);
      this.searchService.buildSearchIndices(this.documents);
      this.enhancedSearchService = new EnhancedSearchService(this);

      console.info(
        `Successfully restored vector store from cache with ${this.documents.length} documents`
      );
      return true;
    } catch (error) {
      console.error("Error restoring vector store from cache", error);
      return false;
    }
  }

  /**
   * 마크다운 파일에서 문서 준비
   */
  private async prepareDocuments(
    files: MarkdownFile[]
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      console.info(`Preparing documents from ${files.length} markdown files`);

      if (!files || files.length === 0) {
        console.warn("No markdown files provided");
        return [];
      }

      let allDocuments: Document<DocumentMetadata>[] = [];

      // 각 파일에 대해 트리 구조에서 문서 생성
      for (const file of files) {
        if (!file.tree) {
          console.warn(`File ${file.name} has no tree structure, skipping`);
          continue;
        }

        console.info(`Processing file: ${file.name}`);

        // createDocumentsFromTree 함수를 사용하여 문서 생성
        const fileDocuments = createDocumentsFromTree(
          file.tree,
          file.name,
          file.githubUrl
        );

        if (fileDocuments.length > 0) {
          console.info(
            `Created ${fileDocuments.length} documents from ${file.name}`
          );
          allDocuments = allDocuments.concat(fileDocuments);
        } else {
          console.warn(`No documents generated from ${file.name}`);
        }
      }

      console.info(`Total documents prepared: ${allDocuments.length}`);

      // 웹 콘텐츠로 문서 향상
      try {
        // 개발 환경에서는 웹 콘텐츠 로딩 건너뛰기
        const isWebContentEnabled = process.env.ENABLE_WEB_CONTENT !== 'false' && process.env.NODE_ENV !== 'development';
        
        if (!isWebContentEnabled) {
          console.info(`Skipping web content enhancement (NODE_ENV: ${process.env.NODE_ENV}, ENABLE_WEB_CONTENT: ${process.env.ENABLE_WEB_CONTENT})`);
          return allDocuments;
        }

        console.info("Starting document enhancement with web content...");
        const enhancer = DocumentEnhancer.getInstance();
        
        // 향상 전 상태 로깅
        console.info(`Documents before enhancement: ${allDocuments.length}`);
        
        // URL이 포함된 문서 확인
        const docsWithUrls = allDocuments.filter(doc => 
          doc.pageContent && doc.pageContent.match(/https?:\/\/[^\s<>"']+/g)
        );
        console.info(`Documents with URLs found: ${docsWithUrls.length}`);
        
        if (docsWithUrls.length > 0) {
          console.info("Sample documents with URLs:");
          docsWithUrls.slice(0, 3).forEach((doc, i) => {
            const urls = doc.pageContent.match(/https?:\/\/[^\s<>"']+/g) || [];
            console.info(`  ${i + 1}. ${doc.metadata.nodeId}: ${urls.join(', ')}`);
          });
        }
        
        const enhancedDocuments = await enhancer.enhanceDocuments(allDocuments);
        console.info(`Documents enhanced with web content: ${enhancedDocuments.length} total`);
        
        // 향상 후 상태 로깅
        const enhancedDocsWithWebContent = enhancedDocuments.filter(doc => 
          doc.metadata.webSources && doc.metadata.webSources.length > 0
        );
        console.info(`Documents with web content added: ${enhancedDocsWithWebContent.length}`);
        
        return enhancedDocuments;
      } catch (error) {
        console.error("Error enhancing documents with web content:", error);
        console.info("Proceeding with original documents without web enhancement");
      return allDocuments;
      }
    } catch (error) {
      console.error("Error preparing documents:", error);
      return [];
    }
  }

  /**
   * 유사도 검색 수행 - 벡터 스토어에서 가장 유사한 문서 반환
   */
  public async similaritySearch(
    query: string,
    k: number = 5
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      this.checkInitialized();

      // 슬랙 사용자 ID 제거 (쿼리 전처리)
      const cleanedQuery = query.replace(/<@[A-Z0-9]+>/g, "").trim();

      if (!cleanedQuery) {
        console.warn("Empty query after cleaning");
        return [];
      }

      console.info(
        `Performing similarity search for query: "${cleanedQuery.substring(
          0,
          50
        )}${cleanedQuery.length > 50 ? "..." : ""}" with k=${k}`
      );

      if (!this.searchService) {
        console.error("Search service is not initialized");
        return [];
      }

      // searchService를 통해 검색 수행
      const results = await this.searchService.similaritySearch(
        cleanedQuery,
        k
      );

      console.info(`Search found ${results.length} results`);
      console.info(results.map((result) => result.pageContent).join("\n--------------------------------\n"));

      if (results.length === 0) {
        console.warn(
          `No results found for query: "${cleanedQuery.substring(0, 50)}${
            cleanedQuery.length > 50 ? "..." : ""
          }"`
        );
      }

      return results;
    } catch (error) {
      console.error("Error performing similarity search:", error);
      this.logVectorStoreState();
      return [];
    }
  }

  /**
   * 벡터 스토어 현재 상태 로깅 (디버깅용)
   */
  private logVectorStoreState(): void {
    try {
      console.info("--- Vector Store Debug Information ---");
      console.info(`Initialized: ${this.isInitialized}`);
      console.info(`Documents count: ${this.documents.length}`);
      console.info(`Store exists: ${!!this.store}`);
      console.info(`SearchService exists: ${!!this.searchService}`);

      // 메모리 벡터 정보 로깅
      if (this.store) {
        const memoryVectors = (this.store as any).memoryVectors;
        console.info(`Memory vectors count: ${memoryVectors?.length || 0}`);

        if (memoryVectors && memoryVectors.length > 0) {
          const sampleVector = memoryVectors[0];
          console.info("Sample vector structure:", {
            hasValues: !!sampleVector?.values,
            valuesLength: sampleVector?.values?.length || 0,
            hasDocument: !!sampleVector?.document,
            documentContentLength:
              sampleVector?.document?.pageContent?.length || 0,
          });
        }
      }
      console.info("-------------------------------------");
    } catch (e) {
      console.error("Error logging vector store state:", e);
    }
  }

  /**
   * 향상된 유사도 검색
   */
  public async enhancedSearch(params: {
    query: string;
    k?: number;
    minRelevanceScore?: number;
    filterByNodeType?: string[];
    filterBySectionId?: string;
    boostSectionSummaries?: boolean;
    boostImportantNodes?: boolean;
    boostByEntityMatch?: boolean;
    includeChunkContext?: boolean;
  }) {
    this.checkInitialized();
    return await this.searchService.enhancedSearch(params);
  }

  /**
   * 엔티티로 문서 찾기
   */
  public findDocumentsByEntity(entity: string): Document<DocumentMetadata>[] {
    this.checkInitialized();
    return this.searchService.findDocumentsByEntity(entity);
  }

  /**
   * 메시지 기반 향상된 검색 - 메타데이터를 활용한 스마트 검색
   */
  public async smartSearchForMessages(
    messages: SlackMessage[], 
    k: number = 5
  ): Promise<Document<DocumentMetadata>[]> {
    this.checkInitialized();
    
    if (!this.enhancedSearchService) {
      console.warn("Enhanced search service not initialized, falling back to basic search");
      const query = messages.map(msg => msg.text).join("\n");
      return await this.similaritySearch(query, k);
    }

    return await this.enhancedSearchService.performEnhancedSearch(messages, k);
  }

  /**
   * 섹션으로 문서 찾기
   */
  public getDocumentsBySection(
    sectionId: string
  ): Document<DocumentMetadata>[] {
    this.checkInitialized();
    return this.searchService.getDocumentsBySection(sectionId);
  }

  /**
   * 벡터 스토어 초기화 상태 체크
   */
  private checkInitialized(): void {
    if (!this.isInitialized || !this.store || !this.searchService) {
      throw new VectorStoreError("Vector store is not initialized", {
        code: "NOT_INITIALIZED",
      });
    }
  }

  /**
   * 벡터 스토어를 리셋하고 재구축
   */
  public async resetAndRebuildVectorStore(): Promise<boolean> {
    console.info("Resetting and rebuilding vector store");

    // 상태 초기화
    this.isInitialized = false;
    this.store = null;
    this.documents = [];
    this.searchService = null as any;

    // 캐시 무효화
    await this.cacheManager.invalidateCache();

    // 현재 파일들이 있으면 벡터 스토어 재구축
    if (this.markdownFiles.length > 0) {
      return await this.initialize(this.markdownFiles, true, true);
    }

    console.warn("No markdown files available to rebuild vector store");
    return false;
  }

  /**
   * 벡터 스토어 상태 진단
   */
  public diagnoseVectorStore(): {
    status: "healthy" | "degraded" | "error";
    details: {
      isInitialized: boolean;
      documentCount: number;
      vectorsCount: number;
      searchIndices: {
        documentsByNodeId: number;
        documentsBySectionId: number;
        sectionSummaries: number;
        entitiesCount: number;
      };
    };
  } {
    try {
      // 초기화 검사
      if (!this.isInitialized || !this.store) {
        return {
          status: "error",
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

      // 벡터 스토어 내부 상태 검사
      const memoryVectors = (this.store as any).memoryVectors;
      const vectorsCount = Array.isArray(memoryVectors)
        ? memoryVectors.length
        : 0;
      const searchIndices = this.searchService
        ? this.searchService.getDiagnostics()
        : {
            documentsByNodeId: 0,
            documentsBySectionId: 0,
            sectionSummaries: 0,
            entitiesCount: 0,
          };

      // 상태 결정
      let status: "healthy" | "degraded" | "error" = "healthy";

      if (vectorsCount === 0 || this.documents.length === 0) {
        status = "error";
      } else if (vectorsCount < this.documents.length * 0.9) {
        // 벡터의 수가 문서 수의 90% 미만이면 저하된 상태로 간주
        status = "degraded";
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
      console.error("Error diagnosing vector store", error);
      return {
        status: "error",
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

  /**
   * 마크다운 파일 설정 및 벡터 스토어 초기화
   * 이 메서드는 기존 코드와의 호환성을 위해 존재합니다
   */
  public async setMarkdownFiles(
    markdownFiles: MarkdownFile[],
    options?: { owner: string; repo: string }
  ): Promise<void> {
    console.info(`Setting markdown files: ${markdownFiles.length} files found`);

    // 초기화 메서드 호출
    const success = await this.initialize(markdownFiles);

    if (!success) {
      console.error("Failed to initialize vector store with markdown files");
      throw new VectorStoreError("Failed to initialize vector store", {
        code: "INITIALIZATION_FAILED",
      });
    }

    console.info(
      "Successfully set markdown files and initialized vector store"
    );
  }

  /**
   * 마크다운 문서 업데이트를 위한 새 컨텐츠 추천
   * 이 메서드는 기존 코드와의 호환성을 위해 존재합니다
   */
  public async getUpdatedMarkdown(
    query: string,
    k: number = 3
  ): Promise<{ content: string; fileName: string; githubUrl: string }[]> {
    this.checkInitialized();

    // 1. 쿼리와 관련성 높은 문서 검색
    const searchResults = await this.similaritySearch(query, k);

    if (!searchResults || searchResults.length === 0) {
      throw new VectorStoreError("No relevant documents found", {
        code: "NO_RESULTS",
      });
    }

    // 2. 결과를 원하는 형식으로 변환
    return searchResults.map((doc) => ({
      content: doc.pageContent,
      fileName: doc.metadata.fileName,
      githubUrl: doc.metadata.githubUrl || "",
    }));
  }

  /**
   * 벡터 스토어 상태 진단 (기존 인터페이스 호환용)
   */
  public isHealthy(): boolean {
    try {
      const diagnosis = this.diagnoseVectorStore();
      return diagnosis.status === "healthy";
    } catch (error) {
      console.error("Error checking vector store health", error);
      return false;
    }
  }

  /**
   * 벡터 스토어 진단 정보 (기존 인터페이스 호환용)
   */
  public get vectorCount(): number {
    try {
      const diagnosis = this.diagnoseVectorStore();
      return diagnosis.details.vectorsCount;
    } catch (error) {
      console.error("Error getting vector count", error);
      return 0;
    }
  }

  /**
   * 벡터 스토어 캐시를 강제로 재구축
   * 이 메서드는 기존 코드와의 호환성을 위해 존재합니다
   */
  public async forceRebuildCache(): Promise<boolean> {
    try {
      console.info("강제 캐시 재구축 시작");

      // 기존 캐시 무효화
      await this.cacheManager.invalidateCache();

      // 파일 유효성 검사
      if (!this.markdownFiles.length) {
        console.error("재구축할 마크다운 파일이 없습니다");
        return false;
      }

      // 벡터 스토어 재구축 (캐시 사용 안 함)
      return await this.buildVectorStore(this.markdownFiles, false, true);
    } catch (error) {
      console.error("캐시 강제 재구축 중 오류 발생:", error);
      return false;
    }
  }

  /**
   * 캐시 관리자 인스턴스 반환
   */
  public getCacheManager(): VectorCacheManager {
    return this.cacheManager;
  }

  /**
   * 파일 이름으로 마크다운 파일 가져오기
   */
  public getMarkdownFile(fileName: string): MarkdownFile | undefined {
    return this.markdownFiles.find((file) => file.name === fileName);
  }

  /**
   * 모든 마크다운 파일 가져오기
   */
  public getAllMarkdownFiles(): MarkdownFile[] {
    return this.markdownFiles;
  }

  /**
   * 현재 로드된 마크다운 파일들로부터 GitHub 저장소 정보 추출
   */
  public extractRepoInfoFromFiles(): { owner: string; repo: string; url: string; path: string } | null {
    if (!this.markdownFiles || this.markdownFiles.length === 0) {
      return null;
    }

    const firstFile = this.markdownFiles[0];
    if (!firstFile.githubUrl) {
      return null;
    }

    // GitHub URL에서 owner, repo 추출
    const urlMatch = firstFile.githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!urlMatch || urlMatch.length < 3) {
      return null;
    }

    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      url: `https://github.com/${urlMatch[1]}/${urlMatch[2]}`,
      path: "" // 기본값으로 루트 경로
    };
  }

  /**
   * 단일 파일 업데이트 후 벡터 스토어 갱신
   */
  public async updateSingleFile(updatedFile: MarkdownFile): Promise<boolean> {
    try {
      console.info(`Updating vector store for file: ${updatedFile.name}`);

      if (!this.isInitialized || !this.store || !this.documents) {
        console.error("Vector store not initialized");
        return false;
      }

      // 기존 파일 찾기 및 업데이트
      const fileIndex = this.markdownFiles.findIndex(file => file.name === updatedFile.name);
      if (fileIndex === -1) {
        console.error(`File not found in markdown files: ${updatedFile.name}`);
        return false;
      }

      // 마크다운 파일 업데이트
      this.markdownFiles[fileIndex] = updatedFile;

      // 해당 파일의 기존 문서들 제거
      const documentsToRemove = this.documents.filter(
        doc => doc.metadata?.fileName === updatedFile.name
      );

      // 새로운 문서들 생성
      const newDocuments = await this.prepareDocumentsFromSingleFile(updatedFile);
      
      if (newDocuments.length === 0) {
        console.warn(`No documents generated from updated file: ${updatedFile.name}`);
        return false;
      }

      // 새로운 임베딩 생성
      const texts = newDocuments.map(doc => {
        const preprocessedContent = preprocessMarkdownForEmbedding(doc.pageContent);
        return preprocessedContent;
      });

      const newEmbeddings = await this.embeddingService.createEmbeddings(texts);
      
      if (!newEmbeddings || newEmbeddings.length === 0) {
        console.error("Failed to create embeddings for updated file");
        return false;
      }

      // 기존 문서들을 새 문서들로 교체
      this.documents = this.documents.filter(doc => doc.metadata?.fileName !== updatedFile.name);
      this.documents.push(...newDocuments);

      // 벡터 스토어 재구축 (현재는 전체 재구축, 향후 부분 업데이트로 최적화 가능)
      const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
      this.store = new MemoryVectorStore(openAIEmbeddings);
      
      // 모든 문서의 임베딩 다시 생성 (현재 한계)
      const allTexts = this.documents.map(doc => preprocessMarkdownForEmbedding(doc.pageContent));
      const allEmbeddings = await this.embeddingService.createEmbeddings(allTexts);
      
      // 벡터 스토어에 로드
      const success = await this.embeddingService.loadEmbeddingsToVectorStore(
        this.store,
        this.documents,
        allEmbeddings
      );

      if (!success) {
        console.error("Failed to reload embeddings to vector store");
        return false;
      }

      // 검색 서비스 재초기화
      this.searchService = new SearchService(this.store, this.embeddingService);
      this.searchService.buildSearchIndices(this.documents);
      this.enhancedSearchService = new EnhancedSearchService(this);

      // 캐시 업데이트
      try {
        const documentTrees = new Map<string, DocumentTree>();
        this.markdownFiles.forEach((file) => {
          if (file.tree) {
            documentTrees.set(file.name, file.tree);
          }
        });

        await this.cacheManager.saveEmbeddingsCache({
          documents: this.documents,
          embeddings: allEmbeddings,
          contentHash: await this.cacheManager.generateContentHash(this.markdownFiles),
          timestamp: Date.now(),
          documentTrees,
        });

        console.info("Successfully updated cache after file update");
      } catch (cacheError) {
        console.error("Failed to update cache:", cacheError);
        // 캐시 업데이트 실패해도 벡터 스토어 업데이트는 성공으로 처리
      }

      console.info(`Successfully updated vector store for ${updatedFile.name}`);
      return true;

    } catch (error) {
      console.error("Error updating single file in vector store:", error);
      return false;
    }
  }

  /**
   * 단일 파일에서 문서 생성
   */
  private async prepareDocumentsFromSingleFile(file: MarkdownFile): Promise<Document<DocumentMetadata>[]> {
    try {
      if (!file.tree) {
        console.warn(`No document tree found for file: ${file.name}`);
        return [];
      }

      const documents = createDocumentsFromTree(file.tree, file.githubUrl, file.name);
      console.info(`Generated ${documents.length} documents from ${file.name}`);
      
      return documents;
    } catch (error) {
      console.error(`Error preparing documents from file ${file.name}:`, error);
      return [];
    }
  }

  /**
   * 특정 문서들을 업데이트 (부분 업데이트)
   */
  public async updateSpecificDocuments(updatedFile: MarkdownFile): Promise<boolean> {
    try {
      console.info(`Updating specific documents for file: ${updatedFile.name}`);

      if (!this.isInitialized || !this.store || !this.documents) {
        console.error("Vector store not initialized");
        return false;
      }

      // 기존 파일 찾기 및 업데이트
      const fileIndex = this.markdownFiles.findIndex(file => file.name === updatedFile.name);
      if (fileIndex === -1) {
        console.error(`File not found in markdown files: ${updatedFile.name}`);
        return false;
      }

      // 마크다운 파일 업데이트
      this.markdownFiles[fileIndex] = updatedFile;

      // 해당 파일의 새로운 문서들 생성
      const newDocuments = await this.prepareDocumentsFromSingleFile(updatedFile);
      
      if (newDocuments.length === 0) {
        console.warn(`No documents generated from updated file: ${updatedFile.name}`);
        return false;
      }

      // 기존 문서들에서 해당 파일의 문서만 교체 (node ID 매핑 유지)
      const oldDocuments = this.documents.filter(doc => doc.metadata?.fileName === updatedFile.name);
      
      // node ID를 기준으로 매핑하여 내용만 업데이트
      for (const newDoc of newDocuments) {
        const oldDocIndex = this.documents.findIndex(
          doc => doc.metadata?.fileName === updatedFile.name && 
                 doc.metadata?.nodeId === newDoc.metadata?.nodeId
        );
        
        if (oldDocIndex !== -1) {
          // 기존 문서의 내용만 업데이트 (node ID 유지)
          this.documents[oldDocIndex] = {
            ...this.documents[oldDocIndex],
            pageContent: newDoc.pageContent,
            metadata: {
              ...this.documents[oldDocIndex].metadata,
              ...newDoc.metadata
            }
          };
          console.info(`Updated document content for node: ${newDoc.metadata?.nodeId}`);
        }
      }

      console.info(`Successfully updated documents for ${updatedFile.name}`);
      return true;

    } catch (error) {
      console.error("Error updating specific documents:", error);
      return false;
    }
  }

  /**
   * 기존 트리에서 특정 노드들만 업데이트 (node ID 유지)
   */
  public async updateSpecificNodes(fileName: string, documentUpdates: any[]): Promise<boolean> {
    try {
      console.info(`Updating specific nodes for file: ${fileName}`);

      if (!this.isInitialized || !this.store || !this.documents) {
        console.error("Vector store not initialized");
        return false;
      }

      const fileIndex = this.markdownFiles.findIndex(file => file.name === fileName);
      if (fileIndex === -1) {
        console.error(`File not found in markdown files: ${fileName}`);
        return false;
      }

      const markdownFile = this.markdownFiles[fileIndex];
      let updatedTree = markdownFile.tree;

      let documentsChanged = false;

      for (const update of documentUpdates) {
        const nodeId = update.nodeId;
        const newContentForNode = update.updatedNodeContent; // This is the raw new markdown content for the node

        if (updatedTree.nodeMap.has(nodeId)) {
          const { updateNodeContent } = await import("services/document/markdown");
          updatedTree = updateNodeContent(updatedTree, nodeId, newContentForNode);
          console.info(`Updated node ${nodeId} content in tree`);

          const docIndex = this.documents.findIndex(
            doc => doc.metadata?.fileName === fileName && 
                   doc.metadata?.nodeId === nodeId
          );

          if (docIndex !== -1) {
            const docToUpdate = this.documents[docIndex];
            const metadata = docToUpdate.metadata as DocumentMetadata;
            
            // Reconstruct pageContent with context prefix
            const contextPrefix = formatHeadingContext(metadata.headingPath || [], metadata.fileName || fileName);
            const newPageContent = contextPrefix + newContentForNode;

            if (this.documents[docIndex].pageContent !== newPageContent) {
              this.documents[docIndex] = {
                ...docToUpdate,
                pageContent: newPageContent,
                metadata: {
                  ...metadata,
                  originalContent: newContentForNode, // Update originalContent as well
                }
              };
              console.info(`Updated in-memory document pageContent for node: ${nodeId}`);
              documentsChanged = true;
            } else {
              console.info(`In-memory document pageContent for node: ${nodeId} already up-to-date.`);
            }
          } else {
            console.warn(`Document for node ${nodeId} not found in this.documents`);
          }
        } else {
          console.warn(`Node ${nodeId} not found in tree`);
        }
      }

      this.markdownFiles[fileIndex] = {
        ...markdownFile,
        tree: updatedTree
      };

      if (!documentsChanged && documentUpdates.length > 0) {
        console.info("No actual changes to document pageContents, vector store rebuild might not be necessary if embeddings depend only on pageContent.");
        // Optionally, one might decide to skip rebuilding if no pageContent actually changed.
        // For now, we proceed to ensure tree changes are also reflected in cache if generateContentHash depends on tree.
      }

      // Rebuild vector store, search services, and cache
      console.info("Rebuilding vector store and search services with updated documents...");
      const openAIEmbeddings = this.embeddingService.getEmbeddingAPI();
      
      const allTexts = this.documents.map(doc => {
        const preprocessedContent = preprocessMarkdownForEmbedding(doc.pageContent);
        return preprocessedContent;
      });
      const allEmbeddings = await this.embeddingService.createEmbeddings(allTexts);
      
      if (!allEmbeddings || allEmbeddings.length === 0) {
        console.error("Failed to create embeddings for updated documents");
        return false; 
      }

      this.store = new MemoryVectorStore(openAIEmbeddings);
      const loadSuccess = await this.embeddingService.loadEmbeddingsToVectorStore(
        this.store,
        this.documents,
        allEmbeddings
      );

      if (!loadSuccess) {
        console.error("Failed to load new embeddings to vector store");
        return false; 
      }

      this.searchService = new SearchService(this.store, this.embeddingService);
      this.searchService.buildSearchIndices(this.documents);
      this.enhancedSearchService = new EnhancedSearchService(this);
      console.info("Successfully rebuilt vector store and search services.");

      try {
        console.info("Updating cache with new embeddings and document trees...");
        const documentTrees = new Map<string, DocumentTree>();
        this.markdownFiles.forEach((file) => {
          if (file.tree) {
            documentTrees.set(file.name, file.tree);
          }
        });

        await this.cacheManager.saveEmbeddingsCache({
          documents: this.documents,
          embeddings: allEmbeddings,
          contentHash: await this.cacheManager.generateContentHash(this.markdownFiles),
          timestamp: Date.now(),
          documentTrees,
        });
        console.info("Successfully updated cache.");
      } catch (cacheError) {
        console.error("Failed to update cache after specific node updates:", cacheError);
      }

      console.info(`Successfully processed ${documentUpdates.length} updates for ${fileName} and rebuilt vector store.`);
      return true;

    } catch (error) {
      console.error("Error updating specific nodes and vector store:", error);
      return false;
    }
  }

  /**
   * 특정 노드 뒤에 새로운 노드를 추가 (APPEND 기능)
   */
  public async appendSpecificNode(fileName: string, referenceNodeId: string, appendedContent: string): Promise<boolean> {
    try {
      console.info(`Appending new node after ${referenceNodeId} for file: ${fileName}`);

      if (!this.isInitialized || !this.store || !this.documents) {
        console.error("Vector store not initialized");
        return false;
      }

      const fileIndex = this.markdownFiles.findIndex(file => file.name === fileName);
      if (fileIndex === -1) {
        console.error(`File not found in markdown files: ${fileName}`);
        return false;
      }

      const markdownFile = this.markdownFiles[fileIndex];
      let updatedTree = markdownFile.tree;

      // 새로운 노드 추가
      const { appendNodeContent } = await import("services/document/markdown");
      updatedTree = appendNodeContent(updatedTree, referenceNodeId, appendedContent);
      console.info(`Appended new node after ${referenceNodeId} in tree`);

      // 새로운 노드의 메타데이터 생성
      const referenceNode = updatedTree.nodeMap.get(referenceNodeId);
      if (!referenceNode) {
        console.error(`Reference node ${referenceNodeId} not found`);
        return false;
      }

      // 새로 추가된 노드들을 찾아서 documents 배열에 추가
      let documentsChanged = false;
      const existingNodeIds = new Set(this.documents
        .filter(doc => doc.metadata?.fileName === fileName)
        .map(doc => doc.metadata?.nodeId)
        .filter(Boolean));

      for (const [nodeId, node] of updatedTree.nodeMap) {
        if (!existingNodeIds.has(nodeId) && nodeId.includes('_append_')) {
          // 새로 추가된 APPEND 노드
          const extNode = node as any; // ExtendedNode type
          
          const metadata: DocumentMetadata = {
            fileName: fileName,
            githubUrl: markdownFile.githubUrl,
            sectionName: extNode.sectionId ? 
              "Section" : "", // 간단하게 처리
            headingPath: [], // TODO: 적절한 headingPath 설정
            nodeId: nodeId,
            originalContent: appendedContent
          };

          const contextPrefix = formatHeadingContext(metadata.headingPath || [], fileName);
          const newDocument = new Document({
            pageContent: contextPrefix + appendedContent,
            metadata
          });

          this.documents.push(newDocument);
          documentsChanged = true;
          console.info(`Added new document for appended node: ${nodeId}`);
        }
      }

      // 마크다운 파일 업데이트
      this.markdownFiles[fileIndex] = {
        ...markdownFile,
        tree: updatedTree
      };

      // 벡터 스토어 재구축
      if (documentsChanged) {
        console.info("Rebuilding vector store with new appended content...");
        const embeddings = await this.embeddingService.createEmbeddings(
          this.documents.map(doc => doc.pageContent)
        );

        this.store = await MemoryVectorStore.fromDocuments(this.documents, this.embeddingService.getEmbeddingAPI());
        console.info("Vector store rebuilt successfully with appended content.");

        // 캐시 업데이트
        try {
          const documentTrees = new Map<string, DocumentTree>();
          this.markdownFiles.forEach((file) => {
            if (file.tree) {
              documentTrees.set(file.name, file.tree);
            }
          });

          await this.cacheManager.saveEmbeddingsCache({
            documents: this.documents,
            embeddings,
            contentHash: await this.cacheManager.generateContentHash(this.markdownFiles),
            timestamp: Date.now(),
            documentTrees,
          });
          console.info("Successfully updated cache with appended content.");
        } catch (cacheError) {
          console.error("Failed to update cache after append:", cacheError);
        }
      }

      console.info(`Successfully appended new node after ${referenceNodeId} for ${fileName}`);
      return true;

    } catch (error) {
      console.error("Error appending node:", error);
      return false;
    }
  }
}
