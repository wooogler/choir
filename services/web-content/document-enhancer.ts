import { Document } from '@langchain/core/documents';
import type { DocumentMetadata } from 'services/vector/types';
import { WebContentLoader } from './web-loader';

/**
 * 문서 향상 서비스
 * 문서의 링크를 분석하여 웹 콘텐츠를 추가합니다.
 */
export class DocumentEnhancer {
  private static instance: DocumentEnhancer;
  private webLoader: WebContentLoader;

  private constructor() {
    this.webLoader = WebContentLoader.getInstance();
  }

  public static getInstance(): DocumentEnhancer {
    if (!DocumentEnhancer.instance) {
      DocumentEnhancer.instance = new DocumentEnhancer();
    }
    return DocumentEnhancer.instance;
  }

  /**
   * 문서 배열을 웹 콘텐츠로 향상시킵니다.
   * @param documents 향상시킬 문서 배열
   * @returns 향상된 문서 배열
   */
  public async enhanceDocuments(documents: Document<DocumentMetadata>[]): Promise<Document<DocumentMetadata>[]> {
    console.info(`Enhancing ${documents.length} documents with web content`);

    const enhancedDocuments: Document<DocumentMetadata>[] = [];
    let webContentCount = 0;
    let cachedWebContentCount = 0;

    for (const doc of documents) {
      try {
        // 이미 webContent가 있는 문서는 스킵 (캐시된 상태)
        if (doc.metadata.webContent && doc.metadata.webContent.length > 0) {
          console.info(`Document ${doc.metadata.nodeId} already has cached web content, skipping enhancement`);
          enhancedDocuments.push(doc);
          cachedWebContentCount++;
          continue;
        }

        // 문서에서 URL 추출
        const urls = this.webLoader.extractUrls(doc.pageContent);

        if (urls.length > 0) {
          console.info(`Found ${urls.length} URLs in document ${doc.metadata.nodeId}: ${urls.join(', ')}`);

          let enhancedPageContent = doc.pageContent;
          const webContent: Array<{ url: string; title: string; content: string }> = [];

          // 각 URL에 대해 웹 콘텐츠 로드 및 추가
          for (const url of urls.slice(0, 3)) {
            // 최대 3개 URL만 처리
            try {
              console.info(`Loading web content from: ${url}`);
              const webDocs = await this.webLoader.loadWebContent(url);
              console.info(
                `Web content loaded: ${webDocs.length} documents, content length: ${webDocs[0]?.pageContent?.length || 0}`,
              );

              if (webDocs.length > 0 && webDocs[0].pageContent.trim().length >= 100) {
                const domain = this.extractDomain(url);
                const title = webDocs[0].metadata.title || domain;

                // 이미 마크다운 링크 형식인지 확인 (더 정확한 방법)
                const alreadyMarkdownLink = doc.pageContent.includes(`](${url})`);

                if (!alreadyMarkdownLink) {
                  // 기존 URL을 마크다운 링크로 변환
                  enhancedPageContent = enhancedPageContent.replace(
                    new RegExp(`(?<!\\()${this.escapeRegExp(url)}(?!\\))`, 'g'),
                    `[${title}](${url})`,
                  );
                }

                // 웹 콘텐츠를 metadata에 저장
                webContent.push({
                  url: url,
                  title: title,
                  content: webDocs[0].pageContent,
                });

                webContentCount++;
                console.info(`Web content added for ${url}, content length: ${webDocs[0].pageContent.length}`);
              } else {
                console.warn(
                  `Web content too short or empty for ${url}: ${webDocs[0]?.pageContent?.length || 0} characters`,
                );
              }
            } catch (error) {
              console.error(`Failed to load web content from ${url}:`, error);
            }
          }

          // 웹 콘텐츠가 추가된 경우 향상된 문서 생성
          if (webContent.length > 0) {
            const enhancedDoc = new Document({
              pageContent: enhancedPageContent, // 원본 콘텐츠만 유지 (링크 형식만 개선)
              metadata: {
                ...doc.metadata,
                webContent: webContent, // 웹 콘텐츠는 metadata에 저장
              },
            });

            enhancedDocuments.push(enhancedDoc);
          } else {
            enhancedDocuments.push(doc);
          }
        } else {
          enhancedDocuments.push(doc);
        }
      } catch (error) {
        console.error(`Error enhancing document ${doc.metadata.nodeId}:`, error);
        enhancedDocuments.push(doc);
      }
    }

    console.info(`Enhanced documents: ${enhancedDocuments.length} total (${webContentCount} web contents added, ${cachedWebContentCount} cached web contents reused)`);
    return enhancedDocuments;
  }

  /**
   * 웹 콘텐츠를 포함한 전체 콘텐츠를 반환합니다.
   */
  public static getFullContentForSearch(document: Document<DocumentMetadata>): string {
    let fullContent = document.pageContent;

    const webContent = document.metadata.webContent;
    if (webContent && webContent.length > 0) {
      webContent.forEach((web) => {
        fullContent += `\n\n--- Web Content from ${web.title} ---\n${web.content}`;
      });
    }

    return fullContent;
  }

  /**
   * URL에서 도메인을 추출합니다.
   */
  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return 'Unknown';
    }
  }

  /**
   * URL들에서 간단한 엔티티를 추출합니다.
   */
  private extractSimpleEntitiesFromUrls(urls: string[]): string[] {
    const entities: string[] = [];

    urls.forEach((url) => {
      try {
        const urlObj = new URL(url);
        entities.push(urlObj.hostname);
      } catch {
        // 잘못된 URL은 무시
      }
    });

    return Array.from(new Set(entities)); // 중복 제거
  }

  /**
   * 텍스트에서 간단한 엔티티를 추출합니다.
   */
  private extractSimpleEntities(text: string): string[] {
    const entities: string[] = [];

    // 대문자로 시작하는 단어들 (고유명사 가능성)
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    entities.push(...properNouns.slice(0, 5));

    // URL 패턴
    const urls = text.match(/https?:\/\/[^\s<>"']+/g) || [];
    entities.push(...urls.slice(0, 2));

    // 이메일 패턴
    const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) || [];
    entities.push(...emails.slice(0, 2));

    return Array.from(new Set(entities)); // 중복 제거
  }

  /**
   * 향상 통계를 반환합니다.
   */
  public async getEnhancementStats(): Promise<{
    cacheStats: { size: number; maxSize: number; urls: string[] };
    totalDocuments: number;
    webContentDocuments: number;
  }> {
    const cacheStats = this.webLoader.getCacheStats();

    return {
      cacheStats,
      totalDocuments: 0, // 실제 구현에서는 추적된 값 사용
      webContentDocuments: 0, // 실제 구현에서는 추적된 값 사용
    };
  }

  /**
   * 캐시를 클리어합니다.
   */
  public clearCache(): void {
    this.webLoader.clearCache();
  }

  /**
   * 정규식 특수 문자를 이스케이프합니다.
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
