import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import type { Document } from "@langchain/core/documents";
import type { GithubCommit, MarkdownFile } from "./github";
import type { MarkdownNode, MarkdownTree } from "./markdown";
import { createDocumentsFromTree, type DocumentMetadata } from "./langchain";
import { treeToMarkdown } from "./markdown";
import GithubService from "./github";
import type { SlackMessage } from "./slack-utils";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// 커스텀 에러 클래스 정의
export class VectorStoreError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "VectorStoreError";
  }
}

// 캐시 관련 인터페이스 및 타입 정의
interface EmbeddingCacheData {
  documents: Document<DocumentMetadata>[];
  embeddings: number[][];
  files: {
    name: string;
    path: string;
    githubUrl: string;
    contentHash: string;
  }[];
  timestamp: number;
}

export default class VectorStoreService {
  private static instance: VectorStoreService;
  private embeddings: OpenAIEmbeddings;
  private store: MemoryVectorStore;
  private markdownFiles: MarkdownFile[] = [];
  private documents: Document<DocumentMetadata>[] = [];
  private logger: Console;
  private cachePath: string;

  private constructor() {
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
    this.store = new MemoryVectorStore(this.embeddings);
    this.logger = console; // 추후 구조화된 로거로 교체 가능

    // 캐시 디렉토리 설정
    this.cachePath = path.join(process.cwd(), ".cache");
    this.ensureCacheDirectory();
  }

  // 캐시 디렉토리 확인 및 생성
  private ensureCacheDirectory(): void {
    try {
      if (!fs.existsSync(this.cachePath)) {
        fs.mkdirSync(this.cachePath, { recursive: true });
        this.logger.info(`Created cache directory at ${this.cachePath}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to create cache directory: ${error}`);
    }
  }

  // 파일 내용의 해시 생성
  private generateContentHash(files: MarkdownFile[]): string {
    const fileData = files.map((file) => ({
      path: file.path,
      content: file.content,
    }));

    return crypto
      .createHash("sha256")
      .update(JSON.stringify(fileData))
      .digest("hex");
  }

  // 캐시 파일 경로 생성
  private getCacheFilePath(owner: string, repo: string): string {
    return path.join(this.cachePath, `${owner}_${repo}_embeddings.json`);
  }

  // 임베딩 캐시 저장
  private async saveEmbeddingsCache(
    owner: string,
    repo: string,
    documents: Document<DocumentMetadata>[],
    files: MarkdownFile[]
  ): Promise<void> {
    try {
      const cacheFilePath = this.getCacheFilePath(owner, repo);

      // 새 임베딩 생성 (벡터 스토어에서 직접 추출이 어려우므로 새로 생성)
      const embeddings: number[][] = [];

      // 모든 문서에 대해 임베딩 생성
      for (const doc of documents) {
        try {
          // OpenAI 임베딩 API를 직접 호출
          const embeddingResult = await this.embeddings.embedQuery(
            doc.pageContent
          );
          embeddings.push(embeddingResult);
          this.logger.debug(
            `Generated embedding for document: ${doc.metadata.fileName}`
          );
        } catch (embError) {
          this.logger.error(
            `Failed to generate embedding for document: ${doc.metadata.fileName}`,
            embError
          );
          // 실패한 경우 빈 임베딩 추가
          embeddings.push([]);
        }
      }

      // 캐시 데이터 생성
      const cacheData: EmbeddingCacheData = {
        documents,
        embeddings,
        files: files.map((file) => ({
          name: file.name,
          path: file.path,
          githubUrl: file.githubUrl,
          contentHash: crypto
            .createHash("sha256")
            .update(file.content)
            .digest("hex"),
        })),
        timestamp: Date.now(),
      };

      // 파일로 저장
      fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData));

      this.logger.info(
        `Saved embeddings cache to ${cacheFilePath} with ${embeddings.length} embeddings`
      );
    } catch (error) {
      this.logger.warn(`Failed to save embeddings cache: ${error}`);
    }
  }

  // 임베딩 캐시 로드
  private async loadEmbeddingsCache(
    owner: string,
    repo: string,
    files: MarkdownFile[]
  ): Promise<{ documents: Document<DocumentMetadata>[]; isValid: boolean }> {
    try {
      const cacheFilePath = this.getCacheFilePath(owner, repo);

      // 캐시 파일이 없으면 빈 결과 반환
      if (!fs.existsSync(cacheFilePath)) {
        return { documents: [], isValid: false };
      }

      // 캐시 파일 읽기
      const cacheData: EmbeddingCacheData = JSON.parse(
        fs.readFileSync(cacheFilePath, "utf-8")
      );

      // 캐시 유효성 검사: 파일 내용 변경 여부 확인
      const isValid = this.validateCache(cacheData, files);

      if (isValid) {
        // 캐시된 임베딩으로 벡터 스토어 복원
        this.restoreVectorStore(cacheData.documents, cacheData.embeddings);
        this.logger.info(`Loaded valid embeddings cache from ${cacheFilePath}`);
        return { documents: cacheData.documents, isValid: true };
      } else {
        this.logger.info(
          `Cache found but invalid (files changed). Recreating embeddings.`
        );
        return { documents: [], isValid: false };
      }
    } catch (error) {
      this.logger.warn(`Failed to load embeddings cache: ${error}`);
      return { documents: [], isValid: false };
    }
  }

  // 캐시 유효성 검사
  private validateCache(
    cacheData: EmbeddingCacheData,
    currentFiles: MarkdownFile[]
  ): boolean {
    // 파일 수가 다르면 캐시 무효
    if (cacheData.files.length !== currentFiles.length) {
      return false;
    }

    // 파일별 해시 비교
    const currentFileMap = new Map(
      currentFiles.map((file) => [
        file.path,
        crypto.createHash("sha256").update(file.content).digest("hex"),
      ])
    );

    // 모든 파일의 해시가 일치하는지 확인
    for (const cachedFile of cacheData.files) {
      const currentHash = currentFileMap.get(cachedFile.path);
      if (!currentHash || currentHash !== cachedFile.contentHash) {
        return false;
      }
    }

    return true;
  }

  // 캐시된 임베딩으로 벡터 스토어 복원
  private restoreVectorStore(
    documents: Document<DocumentMetadata>[],
    embeddings: number[][]
  ): void {
    // 새 벡터 스토어 생성
    this.store = new MemoryVectorStore(this.embeddings);

    // 각 문서와 임베딩을 store에 직접 추가
    const vectorEntries = embeddings.map((embedding, i) => ({
      id: crypto.randomUUID(), // 고유 ID 생성
      values: embedding, // 임베딩 값 배열
      document: {
        pageContent: documents[i].pageContent,
        metadata: documents[i].metadata,
      },
    }));

    // 벡터 스토어에 직접 접근 - private API
    (this.store as any).memoryVectors = vectorEntries;

    this.logger.info(
      `Restored ${vectorEntries.length} vectors to memory store`
    );
  }

  public static getInstance(): VectorStoreService {
    if (!VectorStoreService.instance) {
      VectorStoreService.instance = new VectorStoreService();
    }
    return VectorStoreService.instance;
  }

  // 테스트용 리셋 메서드
  public static resetInstance(): void {
    VectorStoreService.instance = undefined as unknown as VectorStoreService;
  }

  public async setMarkdownFiles(
    files: MarkdownFile[],
    options?: { owner?: string; repo?: string }
  ): Promise<void> {
    try {
      // Github 저장소 정보 (캐싱용)
      const owner = options?.owner || "unknown";
      const repo = options?.repo || "unknown";

      // 마크다운 파일 저장
      this.markdownFiles = files;

      // 캐시된 임베딩 로드 시도
      const { documents, isValid } = await this.loadEmbeddingsCache(
        owner,
        repo,
        files
      );

      if (isValid && documents.length > 0) {
        // 캐시가 유효하면 문서 저장하고 종료
        this.documents = documents;
        this.logger.info(`Using cached embeddings for ${owner}/${repo}`);
        return;
      }

      // 캐시가 없거나 유효하지 않으면 새로 생성
      const newDocuments = files.reduce<Document<DocumentMetadata>[]>(
        (acc, file) => {
          const fileDocuments = createDocumentsFromTree(
            file.tree,
            file.name,
            file.githubUrl
          );
          return acc.concat(fileDocuments);
        },
        []
      );

      // 문서 저장
      this.documents = newDocuments;

      // 벡터 스토어에 추가
      await this.store.addDocuments(newDocuments);
      this.logger.info(
        `Added ${newDocuments.length} documents to vector store`
      );

      // 임베딩 캐시 저장
      await this.saveEmbeddingsCache(owner, repo, newDocuments, files);
    } catch (error: unknown) {
      this.logger.error("Failed to set markdown files", error);
      throw new VectorStoreError(
        `Failed to set markdown files: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "SET_FILES_ERROR"
      );
    }
  }

  public async similaritySearch(query: string, k = 1) {
    try {
      this.logger.info(`Performing similarity search with k=${k}`);
      return this.store.similaritySearch(query, k);
    } catch (error: unknown) {
      this.logger.error("Similarity search failed", error);
      throw new VectorStoreError(
        `Similarity search failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "SEARCH_ERROR"
      );
    }
  }

  // 저장된 데이터 접근을 위한 getter 메서드들
  public getMarkdownFiles(): MarkdownFile[] {
    return this.markdownFiles;
  }

  public getDocuments(): Document<DocumentMetadata>[] {
    return this.documents;
  }

  /*
  바뀐 내용의 메타데이터, 바뀐 내용을 입력 받아 
  tree를 업데이트하고 업데이트된 tree에서 새로운 마크다운을 반환
  */
  public async getUpdatedMarkdown({
    metadata,
    newContent,
  }: {
    metadata: {
      fileName: string;
      sectionIndex: string;
      contentIndex: string;
    };
    newContent: string;
  }): Promise<string | null> {
    try {
      // 파일 찾기
      const file = this.findMarkdownFile(metadata.fileName);
      if (!file) {
        throw new VectorStoreError(
          `File not found: ${metadata.fileName}`,
          "FILE_NOT_FOUND"
        );
      }

      // tree 복제 및 업데이트
      const newTree = this.updateMarkdownTree(file.tree, metadata, newContent);

      // 마크다운으로 변환
      const newMarkdown = treeToMarkdown(newTree);
      this.logger.info(
        `Successfully updated markdown for ${metadata.fileName}`
      );

      return newMarkdown;
    } catch (error: unknown) {
      if (error instanceof VectorStoreError) {
        this.logger.error(`${error.code}: ${error.message}`);
        throw error;
      }

      this.logger.error("Failed to update markdown", error);
      throw new VectorStoreError(
        `Failed to update markdown: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "UPDATE_ERROR"
      );
    }
  }

  /**
   * 파일 이름으로 마크다운 파일 찾기
   */
  private findMarkdownFile(fileName: string): MarkdownFile | undefined {
    return this.markdownFiles.find((f) => f.name === fileName);
  }

  /**
   * 마크다운 트리 업데이트
   */
  private updateMarkdownTree(
    tree: MarkdownTree,
    metadata: { sectionIndex: string; contentIndex: string },
    newContent: string
  ): MarkdownTree {
    // tree 복제
    const newTree = JSON.parse(JSON.stringify(tree)) as MarkdownTree;

    // 트리 업데이트
    let updated = false;
    for (const node of newTree.content) {
      if (this.updateNode(node, metadata, newContent)) {
        updated = true;
        break;
      }
    }

    if (!updated) {
      throw new VectorStoreError(
        `No nodes were updated with the provided metadata`,
        "NODE_UPDATE_FAILED"
      );
    }

    return newTree;
  }

  /**
   * 개별 노드 및 그 하위 노드 업데이트
   */
  private updateNode(
    node: MarkdownNode,
    metadata: { sectionIndex: string; contentIndex: string },
    newContent: string
  ): boolean {
    let updated = false;

    // 하위 노드 업데이트
    if (node.children) {
      for (const child of node.children) {
        if (this.updateNode(child, metadata, newContent)) {
          updated = true;
          // list-item이 업데이트되면 list의 text도 업데이트
          if (node.type === "list" && child.type === "list-item") {
            this.updateListText(node);
          }
        }
      }
    }

    // 현재 노드 업데이트
    if (
      node.type === "list-item" &&
      node.sectionIndex === metadata.sectionIndex &&
      node.contentIndex === metadata.contentIndex
    ) {
      node.text = newContent;
      updated = true;
      this.logger.debug(
        `Updated node with sectionIndex: ${metadata.sectionIndex}, contentIndex: ${metadata.contentIndex}`
      );
    }

    // list 노드가 업데이트되면 list-item들도 업데이트
    if (updated && node.type === "list") {
      this.updateListItems(node);
    }

    return updated;
  }

  /**
   * list 노드의 텍스트 업데이트
   */
  private updateListText(listNode: MarkdownNode): void {
    if (listNode.type !== "list" || !listNode.children) return;

    listNode.text = listNode.children.map((item) => item.text).join("\n");
  }

  /**
   * list 노드의 자식 list-item 노드들 업데이트
   */
  private updateListItems(listNode: MarkdownNode): void {
    if (listNode.type !== "list" || !listNode.children || !listNode.text)
      return;

    const lines = listNode.text.split("\n");

    listNode.children.forEach((child, index) => {
      if (child.type === "list-item" && index < lines.length) {
        child.text = lines[index];
      }
    });
  }
}
