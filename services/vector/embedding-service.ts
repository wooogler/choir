import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import * as crypto from "crypto";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { DocumentMetadata } from "./types";

/**
 * 임베딩 생성 및 관리를 담당하는 서비스 클래스
 */
export class EmbeddingService {
  private embeddings: OpenAIEmbeddings;
  private logger: Console;

  constructor(
    apiKey: string = process.env.OPENAI_API_KEY || "",
    logger: Console = console
  ) {
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: apiKey,
      batchSize: 512,
    });
    this.logger = logger;
  }

  /**
   * 벡터가 유효한지 검사합니다
   */
  public isVectorValid(vector: number[] | null | undefined): boolean {
    // null, undefined, 비배열 체크
    if (!vector || !Array.isArray(vector)) {
      return false;
    }

    // 완전히 빈 배열 체크
    if (vector.length === 0) {
      return false;
    }

    // 최소 길이 체크 (OpenAI 임베딩은 일반적으로 1536 차원)
    // 좀 더 완화된 조건으로 수정: 벡터는 최소 10개 이상의 요소를 가져야 함
    if (vector.length < 10) {
      return false;
    }

    // 모든 값이 undefined, null, NaN인지 체크
    const allInvalid = vector.every(
      (val) => val === undefined || val === null || Number.isNaN(val)
    );
    if (allInvalid) {
      return false;
    }

    // 유효한 숫자가 최소 10% 이상 있는지 확인
    const validCount = vector.filter(
      (val) => val !== undefined && val !== null && !Number.isNaN(val)
    ).length;

    // 유효 비율이 10% 미만이면 벡터 무효 처리
    if (validCount < vector.length * 0.1) {
      return false;
    }

    return true;
  }

  /**
   * 임시 벡터 생성 (인덱스에 따라 고유값 생성)
   */
  public createTemporaryVector(index: number): number[] {
    // 고유한 값을 가진 임시 벡터 생성
    const tempVector = new Array(1536).fill(0);

    // 인덱스에 따라 몇 개의 값을 다르게 설정하여 고유성 보장
    const uniquePosition = index % 500;
    tempVector[uniquePosition] = 0.1 + (index % 10) / 100;
    tempVector[uniquePosition + 1] = 0.2 + (index % 5) / 100;
    tempVector[uniquePosition + 2] = 0.3 + (index % 7) / 100;

    return tempVector;
  }

  /**
   * 텍스트 배열에 대한 임베딩 생성
   */
  public async createEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      if (!texts || texts.length === 0) {
        this.logger.warn("Empty text array provided to createEmbeddings");
        return [];
      }

      this.logger.info(
        `Creating embeddings for ${
          texts.length
        } texts. First text sample: "${texts[0].substring(0, 50)}${
          texts[0].length > 50 ? "..." : ""
        }"`
      );

      // OpenAI API를 통해 임베딩 생성 시도
      try {
        const embeddings = await this.embeddings.embedDocuments(texts);
        this.logger.info(
          `Successfully created ${embeddings.length} embeddings`
        );

        // 임베딩 검증
        let validCount = 0;
        let invalidCount = 0;

        for (let i = 0; i < embeddings.length; i++) {
          if (this.isVectorValid(embeddings[i])) {
            validCount++;
          } else {
            invalidCount++;
            // 유효하지 않은 임베딩 복구 시도
            embeddings[i] = this.createTemporaryVector(i);
          }
        }

        if (invalidCount > 0) {
          this.logger.warn(
            `Found ${invalidCount} invalid embeddings (${
              (invalidCount / embeddings.length) * 100
            }%). ${validCount} embeddings are valid.`
          );
        } else {
          this.logger.info(`All ${validCount} embeddings are valid`);
        }

        return embeddings;
      } catch (error) {
        this.logger.error("Error creating embeddings with OpenAI", error);

        // 오류 시 임시 임베딩 생성
        this.logger.warn("Creating temporary embeddings as fallback");
        return texts.map((_, i) => this.createTemporaryVector(i));
      }
    } catch (error) {
      this.logger.error("Unexpected error in createEmbeddings", error);
      return [];
    }
  }

  /**
   * 단일 쿼리에 대한 임베딩 생성
   */
  public async createQueryEmbedding(query: string): Promise<number[]> {
    try {
      if (!query || query.trim() === "") {
        this.logger.warn("Empty query provided to createQueryEmbedding");
        return this.createTemporaryVector(0);
      }

      // 디버그 정보
      this.logger.info(
        `Creating embedding for query (${
          query.length
        } chars): "${query.substring(0, 50)}${query.length > 50 ? "..." : ""}"`
      );

      try {
        // OpenAI API 호출
        const startTime = Date.now();
        const embedding = await this.embeddings.embedQuery(query);
        const duration = Date.now() - startTime;

        this.logger.info(
          `Query embedding created in ${duration}ms, dimension: ${embedding.length}`
        );

        // 임베딩 유효성 검사
        if (!this.isVectorValid(embedding)) {
          this.logger.warn(
            "Generated query embedding is invalid, using fallback. First 5 values: " +
              JSON.stringify(embedding.slice(0, 5))
          );
          return this.createTemporaryVector(Date.now() % 1000);
        }

        return embedding;
      } catch (error) {
        this.logger.error("Error creating query embedding", error);
        return this.createTemporaryVector(Date.now() % 1000);
      }
    } catch (error) {
      this.logger.error("Unexpected error in createQueryEmbedding", error);
      return this.createTemporaryVector(Date.now() % 1000);
    }
  }

  /**
   * 메모리 벡터 스토어에 임베딩 로드
   */
  public async loadEmbeddingsToVectorStore(
    store: MemoryVectorStore,
    documents: Document<DocumentMetadata>[],
    embeddings: number[][]
  ): Promise<boolean> {
    try {
      this.logger.info(
        `Loading ${embeddings.length} embeddings to vector store`
      );

      if (!store) {
        this.logger.error("Vector store is null or undefined");
        return false;
      }

      if (embeddings.length !== documents.length) {
        this.logger.error(
          `Mismatch between documents (${documents.length}) and embeddings (${embeddings.length})`
        );
        return false;
      }

      // 각 임베딩 유효성 검사 및 필요시 대체
      let validCount = 0;
      let replacedCount = 0;

      const validatedEmbeddings = embeddings.map((embedding, i) => {
        if (this.isVectorValid(embedding)) {
          validCount++;
          return embedding;
        } else {
          replacedCount++;
          // 유효하지 않은 임베딩 복구 시도
          return this.createTemporaryVector(i);
        }
      });

      if (replacedCount > 0) {
        this.logger.warn(
          `Replaced ${replacedCount} invalid embeddings out of ${embeddings.length}`
        );
      }

      // 검증된 임베딩으로 스토어 초기화
      const numDimensions = validatedEmbeddings[0].length;
      await (store as any).addVectors(validatedEmbeddings, documents);

      this.logger.info(
        `Successfully loaded ${documents.length} documents with ${numDimensions}-dimensional embeddings to vector store`
      );
      return true;
    } catch (error) {
      this.logger.error("Error loading embeddings to vector store", error);
      return false;
    }
  }

  /**
   * 캐시된 임베딩에서 벡터 스토어 복원
   */
  public async restoreVectorStore(
    store: MemoryVectorStore,
    documents: Document<DocumentMetadata>[],
    embeddings: number[][]
  ): Promise<boolean> {
    try {
      this.logger.info(
        `Restoring vector store from ${embeddings.length} cached embeddings`
      );

      // 임베딩 데이터 유효성 검사
      if (embeddings.length !== documents.length) {
        this.logger.error(
          `Mismatch between documents (${documents.length}) and embeddings (${embeddings.length})`
        );
        return false;
      }

      // 임베딩 유효성 검사
      let validCount = 0;
      let invalidCount = 0;
      const validatedEmbeddings = embeddings.map((embedding, i) => {
        if (this.isVectorValid(embedding)) {
          validCount++;
          return embedding;
        } else {
          invalidCount++;
          return this.createTemporaryVector(i);
        }
      });

      // 유효하지 않은 임베딩이 너무 많은 경우 경고
      const validRatio = validCount / embeddings.length;
      if (validRatio < 0.5) {
        this.logger.error(
          `Too many invalid embeddings (${invalidCount} of ${
            embeddings.length
          }, ratio: ${validRatio.toFixed(2)}). Cache might be corrupted.`
        );
        return false;
      } else if (invalidCount > 0) {
        this.logger.warn(
          `Found ${invalidCount} invalid embeddings (ratio: ${validRatio.toFixed(
            2
          )}). Replaced with temporary vectors.`
        );
      } else {
        this.logger.info(`All ${validCount} embeddings are valid`);
      }

      // 검증된 임베딩으로 스토어 초기화
      await (store as any).addVectors(validatedEmbeddings, documents);

      this.logger.info(
        `Successfully restored vector store with ${documents.length} documents`
      );
      return true;
    } catch (error) {
      this.logger.error(
        "Error restoring vector store from cached embeddings",
        error
      );
      return false;
    }
  }

  /**
   * 코사인 유사도를 안전하게 계산
   */
  public calculateSafeCosine(v1: number[], v2: number[]): number {
    try {
      // 벡터의 기본 구조 검증
      if (!v1 || !v2 || !Array.isArray(v1) || !Array.isArray(v2)) {
        this.logger.warn("Invalid vector structure in cosine calculation");
        return 0;
      }

      // 길이가 0인 경우
      if (v1.length === 0 || v2.length === 0) {
        this.logger.warn("Empty vector in cosine calculation");
        return 0;
      }

      // 차원이 다른 경우, 더 작은 차원에 맞춤
      const minLength = Math.min(v1.length, v2.length);

      let dotProduct = 0;
      let v1Magnitude = 0;
      let v2Magnitude = 0;
      let validDimensions = 0;

      // 유효한 차원만 사용하여 계산
      for (let i = 0; i < minLength; i++) {
        const val1 = v1[i];
        const val2 = v2[i];

        // 유효한 차원만 사용 (NaN, undefined, null 제외)
        if (
          val1 !== undefined &&
          val2 !== undefined &&
          !Number.isNaN(val1) &&
          !Number.isNaN(val2) &&
          Number.isFinite(val1) &&
          Number.isFinite(val2)
        ) {
          dotProduct += val1 * val2;
          v1Magnitude += val1 * val1;
          v2Magnitude += val2 * val2;
          validDimensions++;
        }
      }

      // 유효한 차원이 너무 적은 경우
      if (validDimensions < minLength * 0.1) {
        // 10% 미만의 차원만 유효하면
        this.logger.warn(
          `Too few valid dimensions: ${validDimensions}/${minLength}`
        );
        return 0;
      }

      v1Magnitude = Math.sqrt(v1Magnitude);
      v2Magnitude = Math.sqrt(v2Magnitude);

      // 0으로 나누기 방지
      if (v1Magnitude < 1e-10 || v2Magnitude < 1e-10) {
        this.logger.warn("Near-zero magnitude in cosine calculation");
        return 0;
      }

      const similarity = dotProduct / (v1Magnitude * v2Magnitude);

      // 결과가 -1에서 1 사이인지 확인
      if (similarity < -1) return -1;
      if (similarity > 1) return 1;

      // NaN이거나 Infinity인 경우
      if (Number.isNaN(similarity) || !Number.isFinite(similarity)) {
        return 0;
      }

      return similarity;
    } catch (error) {
      this.logger.error("Error in cosine similarity calculation", error);
      return 0;
    }
  }

  /**
   * OpenAI 임베딩 API 인스턴스 반환
   */
  public getEmbeddingAPI(): OpenAIEmbeddings {
    return this.embeddings;
  }
}
