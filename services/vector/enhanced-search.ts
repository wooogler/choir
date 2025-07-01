import type { Document } from '@langchain/core/documents';
import type { SlackMessage } from 'services/slack';
import type { VectorStoreService } from './main-service';
import type { DocumentMetadata, SearchParams } from './types';

/**
 * 메시지 분석 결과
 */
interface MessageAnalysis {
  // 파일명 언급
  mentionedFiles: string[];
  // 섹션/헤딩 언급
  mentionedSections: string[];
  // 엔티티 (사람, 조직, 기술 등)
  entities: string[];
  // 우선순위 점수 (0-1)
  priority: number;
}

/**
 * 검색 전략
 */
interface SearchStrategy {
  // 기본 검색 파라미터
  baseParams: SearchParams;
  // 메타데이터 필터
  metadataFilters: {
    preferredFileTypes?: string[];
    preferredSections?: string[];
    excludeNodeTypes?: string[];
    boostFactors: {
      fileNameMatch: number;
      sectionMatch: number;
      entityMatch: number;
    };
  };
}

/**
 * 메타데이터를 활용한 향상된 검색 서비스
 */
export class EnhancedSearchService {
  private vectorStore: VectorStoreService;

  constructor(vectorStore: VectorStoreService) {
    this.vectorStore = vectorStore;
  }

  /**
   * 메시지들을 분석하여 검색에 활용할 정보 추출
   */
  public analyzeMessages(messages: SlackMessage[]): MessageAnalysis {
    const combinedText = messages.map((msg) => msg.text).join(' ');

    // 파일명 패턴 매칭 (.md, .ts, .js, .py 등)
    const filePatterns = /([a-zA-Z0-9_-]+\.(md|ts|js|py|json|yaml|yml|txt|csv))/gi;
    const mentionedFiles = Array.from(new Set((combinedText.match(filePatterns) || []).map((f) => f.toLowerCase())));

    // 섹션/헤딩 패턴 매칭 (# 헤딩, "section", "chapter" 등)
    const sectionPatterns = /(#+ [^#\n]+|section [a-zA-Z0-9\s]+|chapter [a-zA-Z0-9\s]+)/gi;
    const mentionedSections = Array.from(
      new Set(
        (combinedText.match(sectionPatterns) || []).map((s) =>
          s
            .replace(/^#+\s*/, '')
            .trim()
            .toLowerCase(),
        ),
      ),
    );

    // 엔티티 추출 (대문자로 시작하는 단어들, @멘션 등)
    const entityPatterns = /(@[A-Za-z0-9_]+|[A-Z][a-zA-Z0-9_]{2,})/g;
    const entities = Array.from(
      new Set((combinedText.match(entityPatterns) || []).map((e) => e.replace('@', '').toLowerCase())),
    );

    // 우선순위 계산 (더 많은 컨텍스트가 있을수록 높은 점수)
    const priority = Math.min(
      1.0,
      (mentionedFiles.length * 0.4 + mentionedSections.length * 0.3 + entities.length * 0.1) / 2,
    );

    return {
      mentionedFiles,
      mentionedSections,
      entities,
      priority,
    };
  }

  /**
   * 메시지 분석 결과를 바탕으로 검색 전략 생성
   */
  public createSearchStrategy(analysis: MessageAnalysis): SearchStrategy {
    const baseParams: SearchParams = {
      query: '', // 나중에 설정
      k: 10, // 더 많은 결과를 가져와서 필터링
      minRelevanceScore: 0.6,
      boostImportantNodes: true,
      boostSectionSummaries: true,
      boostByEntityMatch: true,
      includeChunkContext: true,
    };

    // 파일 타입 필터링 (언급된 파일이 있으면 해당 확장자 우선)
    const preferredFileTypes =
      analysis.mentionedFiles.length > 0
        ? analysis.mentionedFiles
            .map((f) => f.split('.').pop()?.toLowerCase())
            .filter((ext): ext is string => Boolean(ext))
        : undefined;

    // 섹션 필터링
    const preferredSections = analysis.mentionedSections.length > 0 ? analysis.mentionedSections : undefined;

    // 노드 타입 제외 (우선순위가 매우 낮을 때만 섹션 요약 제외)
    // 빈 섹션은 업데이트가 필요하므로 가능한 포함
    const excludeNodeTypes = analysis.priority < 0.1 ? ['section-summary'] : undefined;

    return {
      baseParams,
      metadataFilters: {
        preferredFileTypes,
        preferredSections,
        excludeNodeTypes,
        boostFactors: {
          fileNameMatch: 1.2,
          sectionMatch: 1.15,
          entityMatch: 1.1,
        },
      },
    };
  }

  /**
   * 메타데이터 기반 문서 점수 계산
   */
  private calculateMetadataScore(
    doc: Document<DocumentMetadata>,
    analysis: MessageAnalysis,
    strategy: SearchStrategy,
  ): number {
    let score = 1.0;
    const metadata = doc.metadata;
    const { boostFactors } = strategy.metadataFilters;

    // 파일명 매칭 부스트
    if (analysis.mentionedFiles.length > 0) {
      const fileName = metadata.fileName?.toLowerCase() || '';
      const hasFileMatch = analysis.mentionedFiles.some(
        (file) => fileName.includes(file) || file.includes(fileName.split('.')[0]),
      );
      if (hasFileMatch) {
        score *= boostFactors.fileNameMatch;
      }
    }

    // 섹션 매칭 부스트
    if (analysis.mentionedSections.length > 0) {
      const sectionName = metadata.sectionName?.toLowerCase() || '';
      const headingPath = metadata.headingPath?.map((h) => h.toLowerCase()) || [];

      const hasSectionMatch = analysis.mentionedSections.some(
        (section) => sectionName.includes(section) || headingPath.some((heading) => heading.includes(section)),
      );

      if (hasSectionMatch) {
        score *= boostFactors.sectionMatch;
      }
    }

    // 엔티티 매칭 부스트
    if (analysis.entities.length > 0 && metadata.entityMentions) {
      const entityMatches = metadata.entityMentions.filter((entity) =>
        analysis.entities.some(
          (queryEntity) => entity.toLowerCase().includes(queryEntity) || queryEntity.includes(entity.toLowerCase()),
        ),
      ).length;

      if (entityMatches > 0) {
        score *= Math.pow(boostFactors.entityMatch, entityMatches);
      }
    }

    // 노드 타입별 조정 제거 - 모든 타입을 동등하게 처리

    // 중요도 점수 반영 (similarity 비중을 높이기 위해 영향력 감소)
    if (metadata.importance !== undefined) {
      score *= 1 + metadata.importance * 0.1;
    }

    return score;
  }

  /**
   * 향상된 검색 수행
   */
  public async performEnhancedSearch(messages: SlackMessage[], k = 5): Promise<Document<DocumentMetadata>[]> {
    // 1. 메시지 분석
    const analysis = this.analyzeMessages(messages);
    console.info('Message analysis:', {
      mentionedFiles: analysis.mentionedFiles,
      mentionedSections: analysis.mentionedSections,
      entities: analysis.entities.slice(0, 5),
      priority: analysis.priority,
    });

    // 2. 검색 전략 생성
    const strategy = this.createSearchStrategy(analysis);

    // 3. 기본 쿼리 생성
    const query = messages.map((msg) => msg.text).join('\n');
    strategy.baseParams.query = query;

    // 4. 향상된 검색 수행
    const searchResults = await this.vectorStore.enhancedSearch(query, k * 2);

    if (!searchResults || searchResults.length === 0) {
      console.warn('No results from enhanced search, falling back to basic search');
      return await this.vectorStore.similaritySearch(query, k);
    }

    // 5. 메타데이터 기반 재점수화
    const rescored = searchResults.map((result: any) => ({
      document: result.document || result,
      score: (result.score || 1) * this.calculateMetadataScore(result.document || result, analysis, strategy),
    }));

    // 6. 점수순 정렬 및 상위 k개 반환
    rescored.sort((a: any, b: any) => b.score - a.score);

    const topResults = rescored.slice(0, k);
    const finalResults = topResults.map((result: any) => result.document);

    console.info(`Enhanced search returned ${finalResults.length} results`);
    console.info(
      'Top results:',
      topResults.map((result) => ({
        fileName: result.document.metadata.fileName,
        headingPath: result.document.metadata.headingPath,
        nodeType: result.document.metadata.nodeType,
        score: Math.round(result.score * 1000) / 1000, // 소수점 3자리까지
        content: result.document.pageContent.substring(0, 100) + '...',
      })),
    );

    return finalResults;
  }
}
