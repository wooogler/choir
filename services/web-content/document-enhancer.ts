import { Document } from '@langchain/core/documents';
import type { DocumentMetadata } from 'services/vector/types';
import { WebContentLoader } from './web-loader';
import { WebContentCache } from './web-content-cache';

/**
 * 문서 향상 서비스
 * 문서의 링크를 분석하여 웹 콘텐츠를 추가합니다.
 */
export class DocumentEnhancer {
  private static instance: DocumentEnhancer;
  private webLoader: WebContentLoader;
  private webCache: WebContentCache;

  private constructor() {
    this.webLoader = WebContentLoader.getInstance();
    this.webCache = WebContentCache.getInstance();
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

    // 전체 문서에서 URL들을 미리 추출하여 캐시 통계 확인
    const allUrls: string[] = [];
    for (const doc of documents) {
      const urls = this.webLoader.extractUrls(doc.pageContent);
      allUrls.push(...urls.slice(0, 3));
    }
    const uniqueUrls = Array.from(new Set(allUrls));
    const cachedContent = this.webCache.getMultipleWebContent(uniqueUrls);
    const totalCachedUrls = Object.keys(cachedContent).length;
    
    console.info(`Pre-scan: ${uniqueUrls.length} unique URLs found, ${totalCachedUrls} already cached (${Math.round(totalCachedUrls/uniqueUrls.length*100)}% cache hit rate)`);

    const enhancedDocuments: Document<DocumentMetadata>[] = [];
    let webContentCount = 0;
    let cachedWebContentCount = 0;

    for (const doc of documents) {
      try {
        // 하위 호환성: 이미 webContent가 있는 문서는 webContentUrls로 변환
        if (doc.metadata.webContent && doc.metadata.webContent.length > 0) {
          console.info(`Document ${doc.metadata.nodeId} has old webContent format, converting to webContentUrls`);
          
          // 기존 webContent를 캐시에 저장
          for (const webItem of doc.metadata.webContent) {
            this.webCache.setWebContent(webItem.url, webItem.title, webItem.content);
          }
          this.webCache.flush();
          
          // webContentUrls로 변환
          const enhancedDoc = new Document({
            pageContent: doc.pageContent,
            metadata: {
              ...doc.metadata,
              webContentUrls: doc.metadata.webContent.map(item => item.url),
              webContent: undefined, // 기존 webContent 제거
            },
          });
          
          enhancedDocuments.push(enhancedDoc);
          cachedWebContentCount++;
          continue;
        }

        // 이미 webContentUrls가 있는 문서는 스킵 (캐시된 상태)
        if (doc.metadata.webContentUrls && doc.metadata.webContentUrls.length > 0) {
          console.info(`Document ${doc.metadata.nodeId} already has cached web content URLs, skipping enhancement`);
          enhancedDocuments.push(doc);
          cachedWebContentCount++;
          continue;
        }

        // 문서에서 URL 추출
        const urls = this.webLoader.extractUrls(doc.pageContent);

        if (urls.length > 0) {
          console.info(`Found ${urls.length} URLs in document ${doc.metadata.nodeId}: ${urls.join(', ')}`);

          // 먼저 캐시에서 이미 로드된 URL들 확인
          const urlsToCheck = urls.slice(0, 3);
          console.info(`URLs to check: ${JSON.stringify(urlsToCheck)}`);
          
          const cachedWebContent = this.webCache.getMultipleWebContent(urlsToCheck);
          const cachedUrls = Object.keys(cachedWebContent);
          const uncachedUrls = urlsToCheck.filter(url => !cachedUrls.includes(url));

          console.info(`Found ${cachedUrls.length} cached URLs: ${JSON.stringify(cachedUrls)}`);
          console.info(`Found ${uncachedUrls.length} uncached URLs: ${JSON.stringify(uncachedUrls)}`);

          let enhancedPageContent = doc.pageContent;
          const validUrls: string[] = [];

          // 캐시된 URL들 처리
          for (const url of cachedUrls) {
            const webItem = cachedWebContent[url];
            const title = webItem.title;

            // 이미 마크다운 링크 형식인지 확인
            const alreadyMarkdownLink = doc.pageContent.includes(`](${url})`);

            if (!alreadyMarkdownLink) {
              // 기존 URL을 마크다운 링크로 변환
              enhancedPageContent = enhancedPageContent.replace(
                new RegExp(`(?<!\\()${this.escapeRegExp(url)}(?!\\))`, 'g'),
                `[${title}](${url})`,
              );
            }

            validUrls.push(url);
            console.info(`Using cached web content for ${url}, content length: ${webItem.content.length}`);
          }

          // 캐시되지 않은 URL들만 새로 로드
          for (const url of uncachedUrls) {
            try {
              console.info(`Loading web content from: ${url}`);
              const webDocs = await this.webLoader.loadWebContent(url);
              console.info(
                `Web content loaded: ${webDocs.length} documents, content length: ${webDocs[0]?.pageContent?.length || 0}`,
              );

              if (webDocs.length > 0 && webDocs[0].pageContent.trim().length >= 100) {
                const domain = this.extractDomain(url);
                const title = webDocs[0].metadata.title || domain;

                // 이미 마크다운 링크 형식인지 확인
                const alreadyMarkdownLink = doc.pageContent.includes(`](${url})`);

                if (!alreadyMarkdownLink) {
                  // 기존 URL을 마크다운 링크로 변환
                  enhancedPageContent = enhancedPageContent.replace(
                    new RegExp(`(?<!\\()${this.escapeRegExp(url)}(?!\\))`, 'g'),
                    `[${title}](${url})`,
                  );
                }

                // 유효한 URL 목록에 추가
                validUrls.push(url);

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
          if (validUrls.length > 0) {
            const enhancedDoc = new Document({
              pageContent: enhancedPageContent, // 원본 콘텐츠만 유지 (링크 형식만 개선)
              metadata: {
                ...doc.metadata,
                webContentUrls: validUrls, // URL 목록만 저장
              },
            });

            enhancedDocuments.push(enhancedDoc);
            cachedWebContentCount += cachedUrls.length;
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

    // 하위 호환성: 기존 webContent 지원
    const webContent = document.metadata.webContent;
    if (webContent && webContent.length > 0) {
      webContent.forEach((web) => {
        fullContent += `\n\n--- Web Content from ${web.title} ---\n${web.content}`;
      });
    }

    // 새로운 방식: webContentUrls에서 동적으로 웹 콘텐츠 로드
    const webContentUrls = document.metadata.webContentUrls;
    if (webContentUrls && webContentUrls.length > 0) {
      const webCache = WebContentCache.getInstance();
      const cachedWebContent = webCache.getMultipleWebContent(webContentUrls);
      
      Object.values(cachedWebContent).forEach((webItem) => {
        fullContent += `\n\n--- Web Content from ${webItem.title} ---\n${webItem.content}`;
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
