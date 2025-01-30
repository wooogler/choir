import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import type { Document } from "@langchain/core/documents";
import type { MarkdownFile } from "./github";
import type { MarkdownNode, MarkdownTree } from "./markdown";
import { createDocumentsFromTree, type DocumentMetadata } from "./langchain";
import { treeToMarkdown } from "./markdown";
import GithubService from "./github";

export default class VectorStoreService {
  private static instance: VectorStoreService;
  private embeddings: OpenAIEmbeddings;
  private store: MemoryVectorStore;
  private markdownFiles: MarkdownFile[] = [];
  private documents: Document<DocumentMetadata>[] = [];

  private constructor() {
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
    this.store = new MemoryVectorStore(this.embeddings);
  }

  public static getInstance(): VectorStoreService {
    if (!VectorStoreService.instance) {
      VectorStoreService.instance = new VectorStoreService();
    }
    return VectorStoreService.instance;
  }

  public async setMarkdownFiles(files: MarkdownFile[]): Promise<void> {
    // 마크다운 파일 저장
    this.markdownFiles = files;

    // 문서로 변환
    const documents = files.reduce<Document<DocumentMetadata>[]>(
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
    this.documents = documents;

    // 벡터 스토어에 추가
    await this.store.addDocuments(documents);
  }

  public async similaritySearch(query: string, k = 1) {
    return this.store.similaritySearch(query, k);
  }

  // 저장된 데이터 접근을 위한 getter 메서드들
  public getMarkdownFiles(): MarkdownFile[] {
    return this.markdownFiles;
  }

  public getDocuments(): Document<DocumentMetadata>[] {
    return this.documents;
  }

  public async updateMarkdownContent(
    metadata: {
      fileName: string;
      sectionIndex: string;
      contentIndex: string;
    },
    newContent: string
  ): Promise<string | null> {
    // 파일 찾기
    const file = this.markdownFiles.find((f) => f.name === metadata.fileName);
    if (!file) return null;

    console.log("metadata", metadata);
    console.log("newContent", newContent);

    // tree 복제
    const newTree = JSON.parse(JSON.stringify(file.tree));

    console.log("newTree\n", JSON.stringify(newTree, null, 2));

    function updateNode(node: MarkdownNode): boolean {
      if (
        node.type === "list-item" &&
        node.sectionIndex === metadata.sectionIndex &&
        node.contentIndex === metadata.contentIndex
      ) {
        console.log("Found node:", {
          type: node.type,
          text: node.text,
          sectionIndex: node.sectionIndex,
          contentIndex: node.contentIndex,
        });
        node.text = newContent;
        return true;
      }

      // content 배열이 있으면 순회
      if ("content" in node) {
        const nodeWithContent = node as { content: MarkdownNode[] };
        for (const child of nodeWithContent.content) {
          if (updateNode(child)) return true;
        }
      }

      // children 배열이 있으면 순회
      if (node.children) {
        for (const child of node.children) {
          if (updateNode(child)) return true;
        }
      }

      return false;
    }

    // 노드 찾아서 업데이트
    const updated = updateNode(newTree);
    if (!updated) {
      console.log("Failed to update node");
      return null;
    }

    const newMarkdown = treeToMarkdown(newTree);

    // GitHub에 업데이트
    const githubService = GithubService.getInstance();
    await githubService.updateMarkdownFile({
      owner: "wooogler",
      repo: "choir_docs",
      path: file.path,
      content: newMarkdown,
      message: "Update document content via CHOIR",
    });

    return newMarkdown;
  }
}
