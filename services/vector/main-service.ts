import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { OpenAIEmbeddings } from "@langchain/openai";
import { MarkdownFile } from "../github";
import { VectorCacheManager } from "./cache-manager";
import { EmbeddingService } from "./embedding-service";
import { SearchService } from "./search-service";
import { DocumentMetadata, VectorStoreError } from "./types";
import { createDocumentsFromTree } from "../langchain";
import { DocumentTree } from "../markdown";

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

      // 파일이 없으면 초기화 실패
      if (!this.markdownFiles.length) {
        console.error(
          "No markdown files provided for vector store initialization"
        );
        throw new VectorStoreError("No markdown files provided", {
          code: "NO_FILES",
        });
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
        console.error("No valid documents found to build vector store");
        return false;
      }

      // 텍스트 추출
      const texts = this.documents.map((doc) => doc.pageContent);
      console.info(
        `Extracted ${texts.length} text chunks for embedding generation`
      );

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
      return allDocuments;
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
}
