import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Document } from '@langchain/core/documents';

/**
 * 웹 콘텐츠 캐시 항목 타입
 */
export interface WebContentCacheItem {
  url: string;
  title: string;
  content: string;
  loadedAt: string;
  contentHash: string;
}

/**
 * 웹 콘텐츠 캐시 데이터 타입
 */
export interface WebContentCacheData {
  version: string;
  items: Record<string, WebContentCacheItem>;
  lastUpdated: string;
}

/**
 * 웹 콘텐츠 디스크 캐시 관리자
 * URL 기반으로 웹 콘텐츠를 중복 없이 저장하고 관리합니다.
 */
export class WebContentCache {
  private static instance: WebContentCache;
  private cachePath: string;
  private cacheData: WebContentCacheData;
  private isDirty = false;

  private constructor() {
    this.cachePath = path.join(process.cwd(), 'data', 'web-content-cache.json');
    this.cacheData = this.loadCacheFromDisk();
  }

  public static getInstance(): WebContentCache {
    if (!WebContentCache.instance) {
      WebContentCache.instance = new WebContentCache();
    }
    return WebContentCache.instance;
  }

  /**
   * 디스크에서 캐시 데이터를 로드합니다.
   */
  private loadCacheFromDisk(): WebContentCacheData {
    try {
      // 캐시 디렉토리 확인 및 생성
      const cacheDir = path.dirname(this.cachePath);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // 캐시 파일 존재 확인
      if (!fs.existsSync(this.cachePath)) {
        console.info('Web content cache file not found, creating new cache');
        return this.createEmptyCache();
      }

      // 캐시 파일 읽기
      const cacheContent = fs.readFileSync(this.cachePath, 'utf-8');
      const data = JSON.parse(cacheContent) as WebContentCacheData;

      // 버전 확인
      if (data.version !== '1.0') {
        console.warn('Web content cache version mismatch, creating new cache');
        return this.createEmptyCache();
      }

      console.info(`Loaded web content cache with ${Object.keys(data.items).length} items`);
      return data;
    } catch (error) {
      console.error('Error loading web content cache:', error);
      return this.createEmptyCache();
    }
  }

  /**
   * 빈 캐시 데이터를 생성합니다.
   */
  private createEmptyCache(): WebContentCacheData {
    return {
      version: '1.0',
      items: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * 캐시 데이터를 디스크에 저장합니다.
   */
  private saveCacheToDisk(): void {
    try {
      this.cacheData.lastUpdated = new Date().toISOString();
      const cacheContent = JSON.stringify(this.cacheData, null, 2);
      fs.writeFileSync(this.cachePath, cacheContent, 'utf-8');
      this.isDirty = false;
      console.info(`Saved web content cache with ${Object.keys(this.cacheData.items).length} items`);
    } catch (error) {
      console.error('Error saving web content cache:', error);
    }
  }

  /**
   * URL을 캐시 키로 변환합니다.
   */
  private generateCacheKey(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex');
  }

  /**
   * 콘텐츠의 해시를 생성합니다.
   */
  private generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * 웹 콘텐츠를 캐시에 저장합니다.
   */
  public setWebContent(url: string, title: string, content: string): void {
    const cacheKey = this.generateCacheKey(url);
    const contentHash = this.generateContentHash(content);

    // 기존 항목과 동일한 콘텐츠인지 확인
    const existingItem = this.cacheData.items[cacheKey];
    if (existingItem && existingItem.contentHash === contentHash) {
      console.info(`Web content for ${url} is already cached with same content`);
      return;
    }

    // 새 항목 저장
    this.cacheData.items[cacheKey] = {
      url,
      title,
      content,
      loadedAt: new Date().toISOString(),
      contentHash,
    };

    this.isDirty = true;
    console.info(`Cached web content for ${url}, content length: ${content.length}`);
  }

  /**
   * 웹 콘텐츠를 캐시에서 가져옵니다.
   */
  public getWebContent(url: string): WebContentCacheItem | null {
    const cacheKey = this.generateCacheKey(url);
    const item = this.cacheData.items[cacheKey];
    
    if (item) {
      console.info(`Found cached web content for ${url}`);
      return item;
    }

    return null;
  }

  /**
   * 여러 URL의 웹 콘텐츠를 가져옵니다.
   */
  public getMultipleWebContent(urls: string[]): Record<string, WebContentCacheItem> {
    const result: Record<string, WebContentCacheItem> = {};
    
    for (const url of urls) {
      const item = this.getWebContent(url);
      if (item) {
        result[url] = item;
      }
    }

    return result;
  }

  /**
   * Document에서 웹 콘텐츠를 추출하여 캐시에 저장합니다.
   */
  public cacheWebContentFromDocument(doc: Document): void {
    const metadata = doc.metadata;
    if (metadata.webContent && Array.isArray(metadata.webContent)) {
      for (const webItem of metadata.webContent) {
        if (webItem.url && webItem.content) {
          this.setWebContent(webItem.url, webItem.title || 'Unknown', webItem.content);
        }
      }
    }
  }

  /**
   * 캐시가 변경되었는지 확인합니다.
   */
  public hasChanges(): boolean {
    return this.isDirty;
  }

  /**
   * 캐시를 디스크에 동기화합니다.
   */
  public flush(): void {
    if (this.isDirty) {
      this.saveCacheToDisk();
    }
  }

  /**
   * 캐시 통계를 반환합니다.
   */
  public getStats(): {
    totalItems: number;
    totalSize: number;
    cacheFilePath: string;
  } {
    const totalSize = Object.values(this.cacheData.items).reduce(
      (sum, item) => sum + item.content.length,
      0
    );

    return {
      totalItems: Object.keys(this.cacheData.items).length,
      totalSize,
      cacheFilePath: this.cachePath,
    };
  }

  /**
   * 캐시를 완전히 클리어합니다.
   */
  public clear(): void {
    this.cacheData = this.createEmptyCache();
    this.isDirty = true;
    this.saveCacheToDisk();
    console.info('Web content cache cleared');
  }

  /**
   * 특정 URL의 캐시를 삭제합니다.
   */
  public removeUrl(url: string): void {
    const cacheKey = this.generateCacheKey(url);
    if (this.cacheData.items[cacheKey]) {
      delete this.cacheData.items[cacheKey];
      this.isDirty = true;
      console.info(`Removed cached web content for ${url}`);
    }
  }

  /**
   * 모든 캐시된 URL 목록을 반환합니다.
   */
  public getAllUrls(): string[] {
    return Object.values(this.cacheData.items).map(item => item.url);
  }
}