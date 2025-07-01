import type { Document } from '@langchain/core/documents';
import type { DocumentTree } from 'services/document';

/**
 * 검색 파라미터 타입
 */
export interface SearchParams {
  query: string;
  k?: number;
  minRelevanceScore?: number;
  boostImportantNodes?: boolean;
  boostSectionSummaries?: boolean;
  boostByEntityMatch?: boolean;
  includeChunkContext?: boolean;
  filterByNodeType?: string[];
  filterBySectionId?: string;
}

/**
 * 문서 메타데이터 타입
 */
export interface DocumentMetadata {
  fileName: string;
  githubUrl?: string;
  nodeId?: string;
  sectionId?: string;
  sectionName?: string;
  nodeType?: string;
  importance?: number;
  chunkIndex?: number;
  totalChunks?: number;
  entityMentions?: string[];
  headingPath?: string[]; // 섹션 계층 경로 (예: ["section 1", "subsection 2", "subsubsection 3"])
  originalContent?: string; // 컨텍스트 정보가 제외된 원본 내용 (LLM 업데이트용)
  webContent?: Array<{
    url: string;
    title: string;
    content: string;
  }>;
  [key: string]: any;
}

/**
 * 임베딩 캐시 데이터 타입
 */
export interface EmbeddingCacheData {
  embeddings: number[][];
  documents: Document<DocumentMetadata>[];
  contentHash: string;
  timestamp: number;
  documentTrees?: Map<string, DocumentTree>;
}

/**
 * 메모리 벡터 타입
 */
export interface MemoryVector {
  content: string;
  embedding: number[];
  document: Document<DocumentMetadata>;
  values: number[];
}

/**
 * 유사도 결과 타입
 */
export interface SimilarityResult {
  similarity: number;
  index: number;
  vector: MemoryVector;
}

/**
 * 향상된 검색 결과 타입
 */
export interface EnhancedSearchResult {
  document: Document<DocumentMetadata>;
  score: number;
  sectionSummary?: Document<DocumentMetadata>;
  relatedChunks?: Document<DocumentMetadata>[];
}

/**
 * 벡터 스토어 에러 클래스
 */
export class VectorStoreError extends Error {
  public readonly cause?: Error;
  public readonly code: string;

  constructor(message: string, options?: { cause?: Error; code?: string }) {
    super(message);
    this.name = 'VectorStoreError';
    this.cause = options?.cause;
    this.code = options?.code || 'UNKNOWN_ERROR';
  }
}
