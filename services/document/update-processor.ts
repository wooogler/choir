import { Document } from "@langchain/core/documents";
import { WebClient } from "@slack/web-api";
import { DocumentMetadata } from "services/vector/types";
import { editMarkdownWithUserMessages } from "services/llm";
import { convertMarkdownToSlackText } from "./markdown";
import { createDiffBlock } from "services/slack";
import { SlackMessage } from "services/slack";
import { VectorStoreService } from "services/vector/main-service";

export interface ProcessedDocument {
  fileName: string;
  githubUrl: string;
  markdownSection: string;
  nodeId: string;
  nodeContent: string;
  updatedNodeContent: string;
  diffBlock: any;
  oldContent: string;
  newContent: string;
  messages: Array<{
    userId: string;
    text: string;
    ts: string;
    username: string;
  }>;
  hasChanges: boolean;
}

export async function processDocument(
  doc: Document<DocumentMetadata>,
  validMessages: SlackMessage[],
  client: WebClient,
  vectorStore: VectorStoreService
): Promise<ProcessedDocument | null> {
  try {
    if (!doc.metadata?.fileName || !doc.metadata?.githubUrl || !doc.metadata?.nodeId) {
      console.log(`메타데이터 누락된 문서 건너뜀:`, doc.metadata);
      return null;
    }

    const fileName = doc.metadata.fileName;
    const markdownFile = vectorStore.getMarkdownFile(fileName);

    if (!markdownFile) {
      console.error(`파일을 찾을 수 없습니다: ${fileName}`);
      return null;
    }

    const docTree = markdownFile.tree;
    const nodeId = doc.metadata.nodeId;

    if (!docTree.nodeMap.has(nodeId)) {
      console.log(`노드 ID가 트리에서 찾을 수 없음: ${nodeId}`);
      return null;
    }

    const nodeContent = doc.pageContent || "";
    const updatedNodeContent = await editMarkdownWithUserMessages(
      nodeContent,
      validMessages,
      client
    );

    const oldSlackText = await convertMarkdownToSlackText(nodeContent);
    const newSlackText = await convertMarkdownToSlackText(
      updatedNodeContent || nodeContent
    );
    const diffBlock = createDiffBlock(oldSlackText, newSlackText);
    const diffHasChanges = oldSlackText !== newSlackText;

    // 메시지 정보 추출 및 중복 제거
    const uniqueMessageInfo = Array.from(
      new Map(
        validMessages.map((msg) => [
          `${msg.userId}-${msg.ts}-${msg.text}`,
          {
            userId: msg.userId,
            text: msg.text,
            ts: msg.ts,
            username: msg.username || "Unknown",
          },
        ])
      ).values()
    );

    return {
      fileName,
      githubUrl: doc.metadata.githubUrl,
      markdownSection: doc.metadata.headingPath?.[0] || doc.metadata.nodeType || "",
      nodeId,
      nodeContent,
      updatedNodeContent: updatedNodeContent || nodeContent,
      diffBlock,
      oldContent: oldSlackText.substring(0, Math.min(oldSlackText.length, 1500)),
      newContent: newSlackText.substring(0, Math.min(newSlackText.length, 1500)),
      messages: uniqueMessageInfo,
      hasChanges: diffHasChanges,
    };
  } catch (error) {
    console.error("문서 처리 중 오류 발생:", error);
    return null;
  }
} 