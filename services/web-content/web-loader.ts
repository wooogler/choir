import { Document } from '@langchain/core/documents';
import puppeteer from 'puppeteer';

/**
 * 웹 콘텐츠 로더 서비스
 * Puppeteer를 직접 사용하여 웹페이지 내용을 추출합니다.
 */
export class WebContentLoader {
  private static instance: WebContentLoader;
  private cache: Map<string, Document[]> = new Map();
  private readonly cacheExpirationTime = 24 * 60 * 60 * 1000; // 24시간
  private readonly maxCacheSize = 1000;

  private constructor() {}

  public static getInstance(): WebContentLoader {
    if (!WebContentLoader.instance) {
      WebContentLoader.instance = new WebContentLoader();
    }
    return WebContentLoader.instance;
  }

  /**
   * URL에서 웹 콘텐츠를 로드합니다.
   * @param url 로드할 웹페이지 URL
   * @returns Document 배열
   */
  public async loadWebContent(url: string): Promise<Document[]> {
    try {
      // 캐시 확인
      const cached = this.getCachedContent(url);
      if (cached) {
        console.info(`Using cached content for URL: ${url}`);
        return cached;
      }

      console.info(`Loading web content from URL: ${url}`);

      // URL 유효성 검사
      if (!this.isValidUrl(url)) {
        console.warn(`Invalid URL format: ${url}`);
        return [];
      }

      // 제외된 URL 확인
      if (this.isExcludedUrl(url)) {
        console.info(`URL excluded from scraping: ${url}`);
        return [];
      }

      // Puppeteer 브라우저 실행
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      const page = await browser.newPage();

      try {
        // 페이지 로드
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });

        // 콘텐츠 추출
        const content = await page.evaluate(() => {
          // 불필요한 요소 제거
          const elementsToRemove = [
            'script',
            'style',
            'nav',
            'footer',
            'header',
            '.advertisement',
            '.ads',
            '.cookie-banner',
            '#comments',
            '.social-share',
            'aside',
            '.sidebar',
          ];

          elementsToRemove.forEach((selector: string) => {
            try {
              const elements = document.querySelectorAll(selector);
              elements.forEach((el: Element) => el.remove());
            } catch (e) {
              // 선택자 오류 무시
            }
          });

          // 메인 콘텐츠 추출
          const contentSelectors = [
            'main',
            'article',
            '.content',
            '.post-content',
            '.entry-content',
            '.article-content',
            '.main-content',
            '.page-content',
            '.blog-content',
            '#content',
            '#main',
          ];

          let mainContent = '';
          let maxLength = 0;

          // 가장 긴 콘텐츠를 가진 선택자 찾기
          for (const selector of contentSelectors) {
            try {
              const elements = document.querySelectorAll(selector);
              for (const element of elements) {
                if (element) {
                  const textContent = (element as HTMLElement).innerText || element.textContent || '';
                  const cleanText = textContent.trim().replace(/\s+/g, ' ');
                  if (cleanText.length > maxLength && cleanText.length > 100) {
                    maxLength = cleanText.length;
                    mainContent = cleanText;
                  }
                }
              }
            } catch (e) {
              // 선택자 오류 무시하고 계속
            }
          }

          // 여전히 콘텐츠가 부족하면 body 전체 텍스트 사용
          if (mainContent.length < 200) {
            try {
              const bodyText = document.body?.innerText || document.body?.textContent || '';
              const cleanBodyText = bodyText.trim().replace(/\s+/g, ' ');
              if (cleanBodyText.length > 200) {
                mainContent = cleanBodyText;
              }
            } catch (e) {
              // 오류 무시
            }
          }

          // 제목 추가 (있다면)
          const title = document.title || '';
          if (title && mainContent && !mainContent.includes(title)) {
            mainContent = `${title}\n\n${mainContent}`;
          }

          return {
            content: mainContent,
            title: title,
            url: window.location.href,
          };
        });

        await browser.close();

        // Document 생성
        const doc = new Document({
          pageContent: content.content,
          metadata: {
            source: url,
            title: content.title,
            loadedAt: new Date().toISOString(),
            type: 'web-content',
          },
        });

        console.info(`Raw document content length: ${content.content.length}`);
        if (content.content.length > 0) {
          console.info(`Raw document content preview: ${content.content.substring(0, 200)}...`);
        }

        const docs = [doc];

        // 콘텐츠가 있는 경우에만 캐시에 저장
        if (content.content.length > 50) {
          this.setCachedContent(url, docs);
        }

        console.info(`Successfully loaded web content from ${url}, ${docs.length} documents`);
        return docs;
      } finally {
        // 브라우저가 열려있다면 닫기
        if (browser) {
          await browser.close();
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load web content from ${url}:`, errorMessage);
      return [];
    }
  }

  /**
   * 여러 URL에서 웹 콘텐츠를 배치로 로드합니다.
   * @param urls 로드할 URL 배열
   * @returns Document 배열
   */
  public async loadMultipleWebContent(urls: string[]): Promise<Document[]> {
    const results: Document[] = [];

    for (const url of urls) {
      try {
        const docs = await this.loadWebContent(url);
        results.push(...docs);

        // 각 요청 사이에 딜레이 추가 (rate limiting)
        await this.delay(1000);
      } catch (error) {
        console.error(`Failed to load content from ${url}:`, error);
      }
    }

    return results;
  }

  /**
   * 텍스트에서 URL을 추출합니다.
   * @param text URL을 추출할 텍스트
   * @returns URL 배열
   */
  public extractUrls(text: string): string[] {
    // 마크다운 링크 형식 매칭
    const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const markdownMatches = Array.from(text.matchAll(markdownLinkRegex));
    const markdownUrls = markdownMatches.map((match) => match[2]);

    // 일반 URL 매칭
    const plainUrlRegex = /https?:\/\/[^\s<>"']+/g;
    const plainUrls = text.match(plainUrlRegex) || [];

    // 모든 URL 합치기
    const allUrls = [...markdownUrls, ...plainUrls];

    // 중복 제거 및 유효한 URL만 필터링
    const uniqueUrls = Array.from(new Set(allUrls))
      .filter((url) => this.isValidUrl(url))
      .filter((url) => !this.isExcludedUrl(url));

    return uniqueUrls;
  }

  /**
   * 캐시에서 콘텐츠를 가져옵니다.
   */
  private getCachedContent(url: string): Document[] | null {
    const cacheKey = this.generateCacheKey(url);
    const cached = this.cache.get(cacheKey);

    if (cached) {
      // 캐시 만료 확인
      const loadedAt = cached[0]?.metadata?.loadedAt;
      if (loadedAt && typeof loadedAt === 'string') {
        const age = Date.now() - new Date(loadedAt).getTime();
        if (age > this.cacheExpirationTime) {
          this.cache.delete(cacheKey);
          return null;
        }
      }

      return cached;
    }

    return null;
  }

  /**
   * 콘텐츠를 캐시에 저장합니다.
   */
  private setCachedContent(url: string, docs: Document[]): void {
    // 캐시 크기 제한
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    const cacheKey = this.generateCacheKey(url);
    this.cache.set(cacheKey, docs);
  }

  /**
   * 캐시 키를 생성합니다.
   */
  private generateCacheKey(url: string): string {
    return btoa(url).replace(/[^a-zA-Z0-9]/g, '');
  }

  /**
   * URL이 유효한지 확인합니다.
   */
  private isValidUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * 제외할 URL인지 확인합니다.
   */
  private isExcludedUrl(url: string): boolean {
    const excludedDomains = [
      'twitter.com',
      'x.com',
      'facebook.com',
      'instagram.com',
      'linkedin.com',
      'youtube.com',
      'tiktok.com',
    ];

    const excludedExtensions = [
      '.pdf',
      '.doc',
      '.docx',
      '.ppt',
      '.pptx',
      '.xls',
      '.xlsx',
      '.zip',
      '.rar',
      '.tar',
      '.gz',
      '.7z',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.svg',
      '.webp',
      '.mp4',
      '.avi',
      '.mov',
      '.wmv',
      '.flv',
      '.mp3',
      '.wav',
    ];

    try {
      const urlObj = new URL(url);

      // 도메인 제외 확인
      if (excludedDomains.some((domain) => urlObj.hostname.includes(domain))) {
        return true;
      }

      // 확장자 제외 확인
      if (excludedExtensions.some((ext) => urlObj.pathname.toLowerCase().endsWith(ext))) {
        return true;
      }

      return false;
    } catch {
      return true; // 잘못된 URL은 제외
    }
  }

  /**
   * 딜레이 함수
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 캐시를 클리어합니다.
   */
  public clearCache(): void {
    this.cache.clear();
    console.info('Web content cache cleared');
  }

  /**
   * 캐시 통계를 반환합니다.
   */
  public getCacheStats(): { size: number; maxSize: number; urls: string[] } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      urls: Array.from(this.cache.keys()),
    };
  }
}
