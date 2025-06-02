import { Document } from "@langchain/core/documents";
import { WebClient } from "@slack/web-api";
import { DocumentMetadata } from "services/vector/types";
import { editMarkdownWithKnowledge } from "services/llm/document-editor";
import { createNewContentFromKnowledge } from "services/llm/content-generator";
import { convertMarkdownToSlackText } from "./markdown";
import { createDiffBlock } from "services/slack";
import { SlackMessage } from "services/slack";
import { VectorStoreService } from "services/vector/main-service";

export interface ProcessedDocument {
  fileName: string;
  githubUrl: string;
  sectionName: string;
  headingPath?: string[]; // 섹션 계층 경로
  nodeId: string;
  nodeContent: string; // UPDATE 시 원본, APPEND 시 마지막 노드 내용
  updatedNodeContent: string; // UPDATE 시 변경된 전체 내용
  diffBlock: any; // UPDATE용 diff 또는 APPEND용 제안 블록
  oldContent: string; // Slack 텍스트 변환된 nodeContent
  newContent: string; // Slack 텍스트 변환된 updatedNodeContent (UPDATE) 또는 appendedNodeContent (APPEND)
  messages: Array<{
    userId: string;
    text: string;
    ts: string;
    username: string;
  }>;
  hasChanges: boolean;
  suggestionType: "UPDATE" | "APPEND"; // 제안 유형
  originalLastNodeContent?: string; // APPEND 시 원본 마지막 노드 내용 (마크다운)
  appendedNodeContent?: string; // APPEND 시 새로 생성된 노드 내용 (마크다운)
}

/**
 * Creates a Slack block to display an append suggestion.
 * Shows the last part of the original content and the content to be appended.
 */
export function createAppendSuggestionBlock(originalMarkdown: string, appendedMarkdown: string): any {
  // For simplicity, we'll just show the raw markdown for now.
  // In a real scenario, these would also be converted to Slack mrkdwn or split into multiple blocks.
  const originalPreview = originalMarkdown.length > 500 ? `...${originalMarkdown.slice(-500)}` : originalMarkdown;
  const appendedPreview = appendedMarkdown.length > 500 ? `${appendedMarkdown.substring(0, 500)}...` : appendedMarkdown;

  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Original last content (Ending with):\n", style: { bold: true } },
          { type: "text", text: originalPreview },
        ],
      },
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "\n\nNew content to append:\n", style: { bold: true } },
          { type: "text", text: appendedPreview, style: { code: true } }, // Show new content as code for distinction
        ],
      },
    ],
  };
}

export async function processDocument(
  doc: Document<DocumentMetadata>,
  knowledgeContent: string,
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

    const nodeContent = doc.metadata.originalContent || doc.pageContent || "";
    // LLM을 호출하여 기존 내용을 기반으로 지식을 통합하거나 새로운 내용을 생성
    const llmEditedContent = await editMarkdownWithKnowledge(
      nodeContent, // 기존 노드 내용 전달
      knowledgeContent // 새로운 지식 전달
    );

    let suggestionType: "UPDATE" | "APPEND";
    let diffBlock: any;
    let hasChanges: boolean;
    let finalUpdatedNodeContentForUpdate = llmEditedContent; // UPDATE 시 사용될 전체 내용
    let appendedText: string | undefined = undefined; // APPEND 시 추가될 내용
    let oldSlackTextForComparison: string;
    let newSlackTextForComparison: string;

    // LLM 결과 분석: 기존 내용이 보존되고 뒤에 내용이 추가되었는지 확인 (APPEND 시도 결정)
    // 이 조건은 이제 APPEND를 시도할지 UPDATE로 갈지 결정하는 데 사용됩니다.
    if (llmEditedContent.startsWith(nodeContent) && llmEditedContent.length > nodeContent.length) {
      suggestionType = "APPEND";
      // 실제 추가될 내용은 createNewContentFromKnowledge를 통해 생성
      appendedText = await createNewContentFromKnowledge(nodeContent, knowledgeContent);
      hasChanges = appendedText.trim() !== "";
      
      if (hasChanges) {
        diffBlock = createAppendSuggestionBlock(nodeContent, appendedText);
      } else {
        // 생성된 내용이 없다면 변경 없는 것으로 간주 (또는 다른 fallback 처리)
        const nodeContentSlack = await convertMarkdownToSlackText(nodeContent);
        diffBlock = createDiffBlock(nodeContentSlack, nodeContentSlack);
      }
      oldSlackTextForComparison = await convertMarkdownToSlackText(nodeContent);
      newSlackTextForComparison = await convertMarkdownToSlackText(appendedText || ""); // appendedText가 undefined일 수 있으므로 방어
    } else {
      suggestionType = "UPDATE";
      finalUpdatedNodeContentForUpdate = llmEditedContent;
      const oldSlackText = await convertMarkdownToSlackText(nodeContent);
      const newSlackText = await convertMarkdownToSlackText(finalUpdatedNodeContentForUpdate || nodeContent);
      diffBlock = createDiffBlock(oldSlackText, newSlackText);
      hasChanges = oldSlackText !== newSlackText;
      oldSlackTextForComparison = oldSlackText;
      newSlackTextForComparison = newSlackText;
    }

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

    const result: ProcessedDocument = {
      fileName,
      githubUrl: doc.metadata.githubUrl,
      sectionName: doc.metadata.sectionName || "",
      headingPath: doc.metadata.headingPath,
      nodeId,
      nodeContent, // APPEND 시에는 마지막 노드의 내용, UPDATE 시에는 원본 노드의 내용
      updatedNodeContent: suggestionType === "UPDATE" ? finalUpdatedNodeContentForUpdate : nodeContent, // APPEND 시에는 원본 노드 내용 유지
      diffBlock,
      oldContent: oldSlackTextForComparison.substring(0, Math.min(oldSlackTextForComparison.length, 1500)),
      newContent: newSlackTextForComparison.substring(0, Math.min(newSlackTextForComparison.length, 1500)),
      messages: uniqueMessageInfo,
      hasChanges,
      suggestionType,
    };

    if (suggestionType === "APPEND") {
      result.originalLastNodeContent = nodeContent;
      result.appendedNodeContent = appendedText;
    }

    // --- 로깅 추가 --- 
    console.log("[processDocument] Suggestion Type:", suggestionType);
    console.log("[processDocument] For node ID:", nodeId);
    if (suggestionType === "APPEND") {
      console.log("[processDocument] Original Node Content (for APPEND):", nodeContent);
      console.log("[processDocument] Generated Appended Text:", appendedText);
    } else {
      console.log("[processDocument] Original Node Content (for UPDATE):", nodeContent);
      console.log("[processDocument] LLM Edited Content (for UPDATE):", finalUpdatedNodeContentForUpdate);
    }
    console.log("[processDocument] Generated Diff Block (for Slack):");
    console.dir(diffBlock, { depth: null }); // diffBlock 객체를 자세히 보기 위해 console.dir 사용
    // --- 로깅 끝 --- 

    return result;

  } catch (error) {
    console.error("문서 처리 중 오류 발생:", error);
    return null;
  }
} 