import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Document } from "@langchain/core/documents";
import { MarkdownFile } from "../github";
import { DocumentMetadata, EmbeddingCacheData } from "./types";
import { DocumentTree, ExtendedNode } from "../markdown";

/**
 * 벡터 스토어의 캐시를 관리하는 클래스
 */
export class VectorCacheManager {
  private cachePath: string;
  private logger: Console;

  constructor(logger: Console = console) {
    // 캐시 디렉토리 설정
    this.cachePath = path.join(
      process.cwd(),
      ".choir",
      "cache",
      "vector-store"
    );
    this.logger = logger;

    // 캐시 디렉토리 존재 확인 및 생성
    this.ensureCacheDirectory();
  }

  /**
   * 캐시 디렉토리 존재 확인 및 생성
   */
  private ensureCacheDirectory(): void {
    try {
      if (!fs.existsSync(this.cachePath)) {
        fs.mkdirSync(this.cachePath, { recursive: true });
        this.logger.info(`Created cache directory: ${this.cachePath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to create cache directory: ${error}`);
    }
  }

  /**
   * 캐시 파일 경로 생성
   */
  public getCacheFilePath(owner: string, repo: string): string {
    return path.join(this.cachePath, `${owner}-${repo}-embeddings.json`);
  }

  /**
   * 마크다운 파일 내용의 해시 생성
   */
  public async generateContentHash(files: MarkdownFile[]): Promise<string> {
    try {
      // 모든 파일 내용을 연결하고 경로와 함께 해시 생성
      const contentStrings = files.map(
        (file) => `${file.path}:${file.content}`
      );

      const allContent = contentStrings.join("\n");

      // SHA-256 해시 생성
      const hash = crypto.createHash("sha256").update(allContent).digest("hex");

      return hash;
    } catch (error) {
      this.logger.error(`Error generating content hash: ${error}`);
      // 오류 시 타임스탬프 기반 임의 문자열 반환
      return `fallback-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 10)}`;
    }
  }

  /**
   * 캐시 ID 생성 (타임스탬프 기반)
   */
  public generateCacheId(): string {
    return `cache-${Date.now()}`;
  }

  /**
   * 임베딩 및 문서를 캐시 파일에 저장
   */
  public async saveEmbeddingsCache(data: EmbeddingCacheData): Promise<boolean> {
    try {
      // 캐시 디렉토리 확인 및 생성
      this.ensureCacheDirectory();

      // 데이터 유효성 검사
      if (!this.validateEmbeddingFormat(data)) {
        this.logger.error("Invalid embedding data format for caching");
        return false;
      }

      // 저장할 파일 경로 결정 (첫 번째 문서의 메타데이터에서 정보 추출)
      const firstDoc = data.documents[0];
      if (!firstDoc || !firstDoc.metadata || !firstDoc.metadata.fileName) {
        this.logger.error(
          "Cannot determine cache file path from document metadata"
        );
        return false;
      }

      // GitHub URL에서 owner와 repo 추출
      const githubUrl = firstDoc.metadata.githubUrl || "";
      const match = githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);

      let owner = "default";
      let repo = "default";

      if (match && match.length >= 3) {
        owner = match[1];
        repo = match[2];
      }

      const cacheFilePath = this.getCacheFilePath(owner, repo);

      // DocumentTree는 Map 객체를 포함하고 있어 직접 JSON으로 변환할 수 없으므로
      // 직렬화 가능한 형태로 변환
      const serializableData = {
        ...data,
        documentTrees: data.documentTrees
          ? this.serializeDocumentTrees(data.documentTrees)
          : undefined,
      };

      // JSON으로 변환하여 저장
      await fs.promises.writeFile(
        cacheFilePath,
        JSON.stringify(serializableData, null, 2)
      );

      this.logger.info(`Saved embeddings cache to: ${cacheFilePath}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to save embeddings cache: ${error}`);
      return false;
    }
  }

  /**
   * 임베딩 데이터 형식 검증
   */
  private validateEmbeddingFormat(data: EmbeddingCacheData): boolean {
    if (!data || typeof data !== "object") return false;

    if (!Array.isArray(data.documents) || data.documents.length === 0) {
      return false;
    }

    if (!Array.isArray(data.embeddings) || data.embeddings.length === 0) {
      return false;
    }

    if (data.documents.length !== data.embeddings.length) {
      return false;
    }

    // 임베딩 배열 구조 확인
    const firstEmbedding = data.embeddings[0];
    if (!Array.isArray(firstEmbedding) || firstEmbedding.length < 1000) {
      return false;
    }

    // 타임스탬프 확인
    if (typeof data.timestamp !== "number") {
      return false;
    }

    // 콘텐츠 해시 확인
    if (typeof data.contentHash !== "string" || data.contentHash.length < 10) {
      return false;
    }

    return true;
  }

  /**
   * 캐시가 현재 파일들과 일치하는지 검증
   */
  public async validateCache(currentFiles: MarkdownFile[]): Promise<boolean> {
    try {
      if (!currentFiles || currentFiles.length === 0) {
        this.logger.warn("No files provided for cache validation");
        return false;
      }

      // GitHub URL에서 owner와 repo 추출
      const firstFile = currentFiles[0];
      if (!firstFile) {
        return false;
      }

      // GitHub URL에서 owner와 repo 정보 추출
      let owner = "default";
      let repo = "default";

      // 첫 번째 파일의 githubUrl에서 owner와 repo 추출
      if (firstFile.githubUrl && firstFile.githubUrl.includes("github.com")) {
        const match = firstFile.githubUrl.match(
          /github\.com\/([^\/]+)\/([^\/]+)/
        );
        if (match && match.length >= 3) {
          owner = match[1];
          repo = match[2];
        }
      }

      const cacheFilePath = this.getCacheFilePath(owner, repo);

      // 캐시 파일 존재 확인
      if (!fs.existsSync(cacheFilePath)) {
        this.logger.info(`No cache file found at: ${cacheFilePath}`);
        return false;
      }

      // 캐시 파일 읽기
      const cacheContent = await fs.promises.readFile(cacheFilePath, "utf-8");
      const cacheData = JSON.parse(cacheContent) as EmbeddingCacheData;

      // 기본 형식 검증
      if (!this.validateEmbeddingFormat(cacheData)) {
        this.logger.warn("Cache file format is invalid");
        await this.backupInvalidCache(cacheFilePath);
        return false;
      }

      // 현재 파일들의 해시 생성
      const currentHash = await this.generateContentHash(currentFiles);

      // 해시 비교
      if (cacheData.contentHash !== currentHash) {
        this.logger.info("Cache is outdated (content hash mismatch)");
        return false;
      }

      this.logger.info("Cache is valid and up-to-date");
      return true;
    } catch (error) {
      this.logger.error(`Error validating cache: ${error}`);
      return false;
    }
  }

  /**
   * 유효하지 않은 캐시 파일 백업 및 삭제
   */
  private async backupInvalidCache(cacheFilePath: string): Promise<void> {
    try {
      if (!fs.existsSync(cacheFilePath)) {
        return;
      }

      const backupPath = `${cacheFilePath}.bak-${Date.now()}`;
      await fs.promises.copyFile(cacheFilePath, backupPath);
      await fs.promises.unlink(cacheFilePath);

      this.logger.info(
        `Invalid cache backed up to ${backupPath} and original deleted`
      );
    } catch (error) {
      this.logger.error(`Failed to backup invalid cache: ${error}`);
    }
  }

  /**
   * 캐시 파일의 상태 로깅
   */
  public async logCacheStatus(cacheFilePath: string): Promise<void> {
    try {
      if (!fs.existsSync(cacheFilePath)) {
        this.logger.info(`Cache file does not exist: ${cacheFilePath}`);
        return;
      }

      const stats = await fs.promises.stat(cacheFilePath);
      const fileSizeInMB = stats.size / (1024 * 1024);
      const lastModified = new Date(stats.mtime).toISOString();

      this.logger.info(
        `Cache file: ${cacheFilePath}, size: ${fileSizeInMB.toFixed(
          2
        )} MB, last modified: ${lastModified}`
      );
    } catch (error) {
      this.logger.error(`Error checking cache file status: ${error}`);
    }
  }

  /**
   * 모든 캐시 파일 찾기
   */
  public async findCacheFiles(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.cachePath);

      // JSON 캐시 파일만 필터링
      const cacheFiles = files
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(this.cachePath, file));

      return cacheFiles;
    } catch (error) {
      this.logger.error(`Error finding cache files: ${error}`);
      return [];
    }
  }

  /**
   * 모든 캐시 파일 무효화 및 백업
   */
  public async invalidateCache(): Promise<void> {
    try {
      const cacheFiles = await this.findCacheFiles();

      if (cacheFiles.length === 0) {
        this.logger.info("No cache files found to invalidate");
        return;
      }

      for (const cacheFile of cacheFiles) {
        await this.backupInvalidCache(cacheFile);
      }

      this.logger.info(`Invalidated ${cacheFiles.length} cache files`);
    } catch (error) {
      this.logger.error(`Error invalidating cache: ${error}`);
    }
  }

  /**
   * 캐시로부터 임베딩 및 문서 로드
   */
  public async loadEmbeddingsCache(
    cacheFilePath: string,
    currentFiles: MarkdownFile[]
  ): Promise<EmbeddingCacheData | null> {
    try {
      // 파일 존재 확인
      if (!fs.existsSync(cacheFilePath)) {
        this.logger.info(`Cache file not found: ${cacheFilePath}`);
        return null;
      }

      // 캐시 파일 읽기
      const cacheData = JSON.parse(
        await fs.promises.readFile(cacheFilePath, "utf-8")
      );

      // 유효성 검사
      if (!this.validateEmbeddingFormat(cacheData)) {
        this.logger.warn(`Invalid cache data format in: ${cacheFilePath}`);
        await this.backupInvalidCache(cacheFilePath);
        return null;
      }

      // 현재 파일들의 해시와 캐시된 해시 비교
      const currentHash = await this.generateContentHash(currentFiles);
      if (cacheData.contentHash !== currentHash) {
        this.logger.info(`Cache is outdated: ${cacheFilePath} (hash mismatch)`);
        return null;
      }

      // DocumentTrees가 있는 경우 역직렬화
      if (cacheData.documentTrees) {
        cacheData.documentTrees = this.deserializeDocumentTrees(
          cacheData.documentTrees
        );
        this.logger.info(
          `Loaded document trees for ${
            Object.keys(cacheData.documentTrees).length
          } files`
        );
      }

      this.logger.info(
        `Successfully loaded embeddings cache with ${cacheData.documents.length} documents`
      );

      return cacheData;
    } catch (error) {
      this.logger.error(`Error loading embeddings cache: ${error}`);
      return null;
    }
  }

  /**
   * DocumentTree Map을 직렬화 가능한 형태로 변환
   */
  private serializeDocumentTrees(
    trees: Map<string, DocumentTree>
  ): Record<string, any> {
    const serialized: Record<string, any> = {};

    trees.forEach((tree, fileName) => {
      // DocumentTree 객체를 직렬화 가능한 형태로 변환
      serialized[fileName] = {
        title: tree.title,
        root: tree.root,
        // Map은 배열로 변환
        nodeMapEntries: Array.from(tree.nodeMap.entries()),
        sectionMapEntries: Array.from(tree.sectionMap.entries()),
      };
    });

    return serialized;
  }

  /**
   * 직렬화된 DocumentTree 객체를 원래 형태로 복원
   */
  private deserializeDocumentTrees(
    serialized: Record<string, any>
  ): Map<string, DocumentTree> {
    const trees = new Map<string, DocumentTree>();

    Object.entries(serialized).forEach(([fileName, data]) => {
      // 새 Map 객체 생성 (타입 단언 추가)
      const nodeMap = new Map(data.nodeMapEntries) as Map<string, ExtendedNode>;
      const sectionMap = new Map(data.sectionMapEntries) as Map<
        string,
        ExtendedNode
      >;

      // DocumentTree 객체 복원
      const tree: DocumentTree = {
        title: data.title,
        root: data.root,
        nodeMap,
        sectionMap,
      };

      trees.set(fileName, tree);
    });

    return trees;
  }
}
