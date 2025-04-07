import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { EmbeddingService } from "./embedding-service";
import {
  DocumentMetadata,
  EnhancedSearchResult,
  MemoryVector,
  SearchParams,
  SimilarityResult,
} from "./types";

/**
 * 유사도 검색 관련 기능을 담당하는 클래스
 */
export class SearchService {
  private store: MemoryVectorStore;
  private embeddingService: EmbeddingService;
  private logger: Console;

  // 빠른 검색을 위한 인덱스
  private nodeIdToDocument: Map<string, Document<DocumentMetadata>> = new Map();
  private sectionIdToDocuments: Map<string, Document<DocumentMetadata>[]> =
    new Map();
  private sectionSummaries: Map<string, Document<DocumentMetadata>> = new Map();
  private entityToDocuments: Map<string, Document<DocumentMetadata>[]> =
    new Map();

  constructor(
    store: MemoryVectorStore,
    embeddingService: EmbeddingService,
    logger: Console = console
  ) {
    this.store = store;
    this.embeddingService = embeddingService;
    this.logger = logger;
  }

  /**
   * 인덱스 초기화
   */
  public clearIndices(): void {
    this.nodeIdToDocument.clear();
    this.sectionIdToDocuments.clear();
    this.sectionSummaries.clear();
    this.entityToDocuments.clear();
  }

  /**
   * 검색 인덱스 구축 - 빠른 검색을 위한 참조 맵 생성
   */
  public buildSearchIndices(documents: Document<DocumentMetadata>[]): void {
    // 인덱스 초기화
    this.clearIndices();

    for (const doc of documents) {
      const metadata = doc.metadata;

      // nodeId -> Document 맵
      if (metadata.nodeId) {
        this.nodeIdToDocument.set(metadata.nodeId, doc);
      }

      // sectionId -> Documents 맵
      if (metadata.sectionId) {
        if (!this.sectionIdToDocuments.has(metadata.sectionId)) {
          this.sectionIdToDocuments.set(metadata.sectionId, []);
        }
        this.sectionIdToDocuments.get(metadata.sectionId)!.push(doc);

        // 섹션 요약 문서 저장
        if (metadata.nodeType === "section-summary") {
          this.sectionSummaries.set(metadata.sectionId, doc);
        }
      }

      // 엔티티 -> Documents 맵
      if (metadata.entityMentions && metadata.entityMentions.length > 0) {
        for (const entity of metadata.entityMentions) {
          if (!this.entityToDocuments.has(entity)) {
            this.entityToDocuments.set(entity, []);
          }
          this.entityToDocuments.get(entity)!.push(doc);
        }
      }
    }

    this.logger.info(`Built search indices for ${documents.length} documents`);
  }

  /**
   * 기본 유사도 검색 - 쿼리와 가장 유사한 문서를 반환
   */
  public async similaritySearch(
    query: string,
    k = 5
  ): Promise<Document<DocumentMetadata>[]> {
    try {
      // 슬랙 사용자 ID만 제거하고 나머지 콘텐츠는 유지
      // <@U123456> 형태의 사용자 ID는 의미가 없으므로 제거
      // 이렇게 하면 "Zoom", "Skype" 같은 중요 키워드가 보존됨
      const cleanedQuery = query.replace(/<@[A-Z0-9]+>/g, "").trim();

      this.logger.info(
        `Performing basic similarity search with k=${k}, query="${cleanedQuery.substring(
          0,
          50
        )}${cleanedQuery.length > 50 ? "..." : ""}"`
      );

      // 쿼리에서 중요 키워드 추출 및 로깅
      const importantKeywords = this.extractImportantKeywords(cleanedQuery);
      if (importantKeywords.length > 0) {
        this.logger.info(`중요 키워드 감지: ${importantKeywords.join(", ")}`);
      }

      // 입력 검증 추가
      if (!cleanedQuery || cleanedQuery.trim() === "") {
        this.logger.warn(
          "Empty query provided to similaritySearch after cleaning"
        );
        return [];
      }

      // 벡터 스토어 검증
      if (!this.store) {
        this.logger.warn("Vector store is not initialized");
        return [];
      }

      // 메모리 벡터 스토어의 내장 similaritySearch 메서드 사용
      try {
        this.logger.info("Using LangChain's built-in similarity search");
        const searchResults = await this.store.similaritySearch(
          cleanedQuery,
          k
        );

        // 타입 변환 - LangChain 결과를 우리의 Document<DocumentMetadata>[] 타입으로 변환
        const results = searchResults.map((doc) => {
          return new Document({
            pageContent: doc.pageContent,
            metadata: doc.metadata as DocumentMetadata,
          });
        });

        this.logger.info(`Found ${results.length} results for query`);

        if (results.length === 0) {
          this.logger.warn(
            "No valid similarity results found using LangChain's method"
          );
          // 디버그 정보 추가
          this.debugVectorStoreState();
        }

        return results;
      } catch (searchError) {
        this.logger.error("LangChain similarity search failed:", searchError);
        this.debugVectorStoreState();
        return [];
      }
    } catch (error) {
      this.logger.error("Similarity search failed", error);
      return [];
    }
  }

  /**
   * 쿼리에서 중요 키워드 추출 (Zoom, Skype 등의 특정 키워드 강조)
   * @private
   */
  private extractImportantKeywords(query: string): string[] {
    // 특정 서비스 이름이나 중요한 기술 용어를 추출
    const keywords = [
      "Zoom",
      "Skype",
      "Teams",
      "Meet",
      "Slack",
      "GitHub",
      "Git",
      "API",
      "Docker",
      "Kubernetes",
      "Python",
      "JavaScript",
      "TypeScript",
      "React",
      "Node",
    ];

    // 대소문자 구분 없이 키워드가 쿼리에 포함되어 있는지 확인
    const foundKeywords = keywords.filter((keyword) =>
      query.toLowerCase().includes(keyword.toLowerCase())
    );

    return foundKeywords;
  }

  /**
   * 벡터 스토어 상태 디버그 정보 출력
   */
  private debugVectorStoreState(): void {
    try {
      const memoryVectors = (this.store as any).memoryVectors;

      this.logger.info(
        `Vector store debug info: memoryVectors count = ${
          memoryVectors?.length || 0
        }`
      );

      if (memoryVectors && memoryVectors.length > 0) {
        const sampleVector = memoryVectors[0];
        this.logger.info(
          `Sample vector structure: ${JSON.stringify({
            id: sampleVector.id,
            hasValues: !!sampleVector.values,
            valuesType: typeof sampleVector.values,
            isValuesArray: Array.isArray(sampleVector.values),
            valuesLength: Array.isArray(sampleVector.values)
              ? sampleVector.values.length
              : 0,
            hasDocument: !!sampleVector.document,
            hasMetadata: !!sampleVector.document?.metadata,
          })}`
        );

        // 벡터의 첫 번째 값들 확인
        if (
          Array.isArray(sampleVector.values) &&
          sampleVector.values.length > 0
        ) {
          this.logger.info(
            `Vector first 3 values: ${sampleVector.values
              .slice(0, 3)
              .join(", ")}`
          );
        }
      }
    } catch (error) {
      this.logger.error("Error analyzing vector store state:", error);
    }
  }

  /**
   * 향상된 유사도 검색 - 다양한 파라미터를 통한 검색 최적화
   */
  public async enhancedSearch(
    params: SearchParams
  ): Promise<EnhancedSearchResult[]> {
    try {
      this.logger.info(`Performing enhanced search for: ${params.query}`);

      // 기본값 설정
      const k = params.k || 5;
      const minRelevanceScore = params.minRelevanceScore || 0.7;
      const boostImportantNodes = params.boostImportantNodes ?? true;
      const boostSectionSummaries = params.boostSectionSummaries ?? true;
      const boostByEntityMatch = params.boostByEntityMatch ?? true;
      const includeChunkContext = params.includeChunkContext ?? true;

      // 쿼리에서 엔티티 추출
      const queryEntities = this.extractQueryEntities(params.query);

      // 기본 벡터 검색 수행
      let searchResults = await this.store.similaritySearchWithScore(
        params.query,
        k * 2
      );

      // 결과 후처리 및 향상
      let enhancedResults: EnhancedSearchResult[] = searchResults.map(
        ([doc, score]) => {
          const metadata = doc.metadata as DocumentMetadata;
          let finalScore = score;

          // 중요도 점수로 부스팅
          if (boostImportantNodes && metadata.importance !== undefined) {
            finalScore *= 1 + metadata.importance * 0.3; // 중요도가 높을수록 점수 증가
          }

          // 섹션 요약 부스팅
          if (
            boostSectionSummaries &&
            metadata.nodeType === "section-summary"
          ) {
            finalScore *= 1.2; // 섹션 요약은 20% 점수 증가
          }

          // 엔티티 매칭 부스팅
          if (
            boostByEntityMatch &&
            metadata.entityMentions &&
            queryEntities.length > 0
          ) {
            const matchCount = metadata.entityMentions.filter((entity) =>
              queryEntities.includes(entity)
            ).length;

            if (matchCount > 0) {
              const entityBoost = Math.min(0.3, matchCount * 0.1); // 최대 30%까지 부스트
              finalScore *= 1 + entityBoost;
            }
          }

          // 노드 타입 필터링
          if (
            params.filterByNodeType &&
            metadata.nodeType &&
            !params.filterByNodeType.includes(metadata.nodeType)
          ) {
            finalScore = 0; // 필터링된 노드 타입은 제외
          }

          // 섹션 ID 필터링
          if (
            params.filterBySectionId &&
            metadata.sectionId !== params.filterBySectionId
          ) {
            finalScore = 0; // 다른 섹션 제외
          }

          return {
            document: doc as Document<DocumentMetadata>,
            score: finalScore,
          };
        }
      );

      // 점수 기준 정렬 및 필터링
      enhancedResults = enhancedResults
        .filter((result) => result.score >= minRelevanceScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      // 관련 컨텍스트 추가 (청크, 섹션 요약 등)
      if (includeChunkContext) {
        enhancedResults = await this.addRelatedContext(enhancedResults);
      }

      return enhancedResults;
    } catch (error) {
      this.logger.error("Enhanced search failed", error);
      return [];
    }
  }

  /**
   * 검색 결과에 관련 컨텍스트 추가
   */
  private async addRelatedContext(
    results: EnhancedSearchResult[]
  ): Promise<EnhancedSearchResult[]> {
    for (const result of results) {
      const metadata = result.document.metadata;

      // 1. 섹션 요약 추가
      if (metadata.sectionId && this.sectionSummaries.has(metadata.sectionId)) {
        result.sectionSummary = this.sectionSummaries.get(metadata.sectionId);
      }

      // 2. 관련 청크 추가 (같은 노드의 다른 청크)
      if (metadata.nodeId && metadata.totalChunks && metadata.totalChunks > 1) {
        result.relatedChunks = this.findRelatedChunks(
          metadata.nodeId,
          metadata.chunkIndex
        );
      }
    }

    return results;
  }

  /**
   * 동일 노드의 관련 청크 찾기
   */
  private findRelatedChunks(
    nodeId: string | undefined,
    currentChunkIndex?: number
  ): Document<DocumentMetadata>[] {
    const relatedChunks: Document<DocumentMetadata>[] = [];

    // nodeId가 없으면 빈 배열 반환
    if (!nodeId) {
      return relatedChunks;
    }

    // 같은 nodeId를 가진 모든 문서 찾기
    for (const doc of Array.from(this.nodeIdToDocument.values())) {
      if (
        doc.metadata.nodeId === nodeId &&
        doc.metadata.chunkIndex !== currentChunkIndex
      ) {
        relatedChunks.push(doc);
      }
    }

    // 청크 인덱스 순으로 정렬
    return relatedChunks.sort(
      (a, b) => (a.metadata.chunkIndex || 0) - (b.metadata.chunkIndex || 0)
    );
  }

  /**
   * 쿼리에서 중요 엔티티 추출
   */
  private extractQueryEntities(query: string): string[] {
    // 간단한 규칙 기반 엔티티 추출 (대문자로 시작하는 단어, 특수 구문 등)
    const entities: string[] = [];

    // 큰따옴표 내의 구문 추출 (정확한 매칭 구문)
    const quotedPhrases = query.match(/"([^"]+)"/g) || [];
    for (const phrase of quotedPhrases) {
      entities.push(phrase.replace(/"/g, "").toLowerCase());
    }

    // 대문자로 시작하는 단어 (고유명사 가능성)
    const capitalizedWords = query.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    for (const word of capitalizedWords) {
      entities.push(word.toLowerCase());
    }

    // 코드 관련 키워드 (함수, 변수, 클래스 등)
    const codePatterns = [
      /\b([a-zA-Z][a-zA-Z0-9_]{3,})\(/g, // 함수 호출
      /\b[a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*\b/g, // 카멜케이스
      /\b[A-Z][a-zA-Z0-9_]+\b/g, // 파스칼케이스
    ];

    for (const pattern of codePatterns) {
      const matches = query.match(pattern) || [];
      for (const match of matches) {
        // 괄호 등 제거
        const cleaned = match.replace(/\(.*$/, "").toLowerCase();
        if (cleaned.length > 2) {
          entities.push(cleaned);
        }
      }
    }

    // 중복 제거
    return [...new Set(entities)];
  }

  /**
   * 진단 정보 반환
   */
  public getDiagnostics(): {
    documentsByNodeId: number;
    documentsBySectionId: number;
    sectionSummaries: number;
    entitiesCount: number;
  } {
    return {
      documentsByNodeId: this.nodeIdToDocument.size,
      documentsBySectionId: this.sectionIdToDocuments.size,
      sectionSummaries: this.sectionSummaries.size,
      entitiesCount: this.entityToDocuments.size,
    };
  }

  /**
   * 특정 섹션의 문서들 가져오기
   */
  public getDocumentsBySection(
    sectionId: string
  ): Document<DocumentMetadata>[] {
    if (this.sectionIdToDocuments.has(sectionId)) {
      return this.sectionIdToDocuments.get(sectionId) || [];
    }
    return [];
  }

  /**
   * 엔티티로 문서 검색
   */
  public findDocumentsByEntity(entity: string): Document<DocumentMetadata>[] {
    const lowercaseEntity = entity.toLowerCase();
    // 부분 일치 검색
    const matchingEntities = Array.from(this.entityToDocuments.keys()).filter(
      (key) => key.toLowerCase().includes(lowercaseEntity)
    );

    // 중복 없이 모든 문서 수집
    const resultSet = new Set<Document<DocumentMetadata>>();

    for (const key of matchingEntities) {
      const docs = this.entityToDocuments.get(key) || [];
      for (const doc of docs) {
        resultSet.add(doc);
      }
    }

    return Array.from(resultSet);
  }
}
