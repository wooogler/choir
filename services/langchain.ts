import { Document } from "@langchain/core/documents";
import type { MarkdownNode, MarkdownTree } from "./markdown";

export interface DocumentMetadata {
  fileName: string;
  sectionIndex: string;
  contentIndex?: string;
  githubUrl: string;
}

export function createDocumentsFromTree(
  tree: MarkdownTree,
  fileName: string,
  githubUrl: string
): Document<DocumentMetadata>[] {
  const documents: Document<DocumentMetadata>[] = [];

  function processNode(node: MarkdownNode) {
    if (node.children && node.children.length > 0) {
      // 섹션과 모든 자식 내용을 포함하는 Document
      documents.push(
        new Document({
          pageContent: `${node.text}${node.children[0].text}`,
          metadata: {
            fileName,
            sectionIndex: node.sectionIndex || "",
            githubUrl,
          },
        })
      );

      // 각 list-item에 대한 Document 생성
      if (node.children[0].type === "list") {
        for (const item of node.children[0].children) {
          documents.push(
            new Document({
              pageContent: `${node.text}---\n${item.text}`,
              metadata: {
                fileName,
                sectionIndex: node.sectionIndex || "",
                contentIndex: item.contentIndex,
                githubUrl,
              },
            })
          );
        }
      }
    }

    // 하위 섹션 처리
    for (const child of node.children) {
      if (child.type === "section") {
        processNode(child);
      }
    }
  }

  // 최상위 섹션들 처리
  for (const node of tree.content) {
    if (node.type === "section") {
      processNode(node);
    }
  }

  return documents;
}
