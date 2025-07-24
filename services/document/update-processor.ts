import type { Document } from '@langchain/core/documents';
import type { WebClient } from '@slack/web-api';
import {
  type NewSectionSuggestion,
  createNewSectionFromKnowledge,
} from 'services/llm/content-generator';
import { editMarkdownWithKnowledge } from 'services/llm/document-editor';
import { createDiffBlock } from 'services/slack';
import type { SlackMessage } from 'services/slack';
import type { VectorStoreService } from 'services/vector/main-service';
import type { DocumentMetadata } from 'services/vector/types';
import { convertMarkdownToSlackText } from './markdown';

export interface ProcessedDocument {
  fileName: string;
  githubUrl: string;
  sectionName: string;
  headingPath?: string; // 섹션 계층 경로 (UI 표시용)
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
  suggestionType: 'UPDATE' | 'APPEND'; // 제안 유형
  originalLastNodeContent?: string; // APPEND 시 원본 마지막 노드 내용 (마크다운)
  appendedNodeContent?: string; // APPEND 시 새로 생성된 노드 내용 (마크다운)
  newSectionSuggestion?: NewSectionSuggestion; // APPEND 시 새 섹션 제안
}

/**
 * Creates a Slack block to display an append suggestion.
 * Shows the reference content and the content to be appended after it.
 */
export function createAppendSuggestionBlock(originalMarkdown: string, appendedMarkdown: string): any {
  // Create a diff-like display: original content followed by new content (bold)

  // Remove "File:" and "Path:" lines from original content since they're already shown in the title
  const cleanedOriginalMarkdown = originalMarkdown
    .split('\n')
    .filter((line) => !line.startsWith('File:') && !line.startsWith('Path:'))
    .join('\n')
    .trim();

  // If content is empty, show section header instead
  if (!cleanedOriginalMarkdown) {
    // Extract section name from original markdown (Path: line)
    const pathLine = originalMarkdown.split('\n').find((line) => line.startsWith('Path:'));
    const sectionName = pathLine ? pathLine.replace('Path:', '').trim() : 'Section';

    return {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_quote',
          elements: [
            { type: 'text', text: `## ${sectionName}`, style: { bold: true } },
            { type: 'text', text: '\n\n' },
            { type: 'text', text: appendedMarkdown, style: { bold: true } },
          ],
        },
      ],
    };
  }

  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_quote',
        elements: [
          { type: 'text', text: cleanedOriginalMarkdown },
          { type: 'text', text: '\n\n' },
          { type: 'text', text: appendedMarkdown, style: { bold: true } },
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
  vectorStore: VectorStoreService,
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

    const nodeContent = doc.metadata.originalContent || doc.pageContent || '';
    // LLM을 호출하여 기존 내용을 기반으로 지식을 통합하거나 새로운 내용을 생성
    const editResult = await editMarkdownWithKnowledge(
      nodeContent, // 기존 노드 내용 전달
      knowledgeContent, // 새로운 지식 전달
    );

    let suggestionType: 'UPDATE' | 'APPEND';
    let diffBlock: any;
    let hasChanges: boolean;
    let finalUpdatedNodeContentForUpdate: string;
    let appendedText: string | undefined = undefined;
    let oldSlackTextForComparison: string;
    let newSlackTextForComparison: string;

    // AI의 결정에 따라 처리
    if (editResult.action === 'append') {
      suggestionType = 'APPEND';
      appendedText = editResult.content;
      hasChanges = true;
      diffBlock = createAppendSuggestionBlock(nodeContent, appendedText);
      oldSlackTextForComparison = await convertMarkdownToSlackText(nodeContent);
      newSlackTextForComparison = await convertMarkdownToSlackText(appendedText);
      finalUpdatedNodeContentForUpdate = nodeContent; // APPEND 시에는 원본 노드 내용 유지

      console.log('[processDocument] AI chose APPEND action');
    } else {
      // editResult.action === 'update'
      suggestionType = 'UPDATE';
      finalUpdatedNodeContentForUpdate = editResult.content;
      const oldSlackText = await convertMarkdownToSlackText(nodeContent);
      const newSlackText = await convertMarkdownToSlackText(finalUpdatedNodeContentForUpdate);
      
      // 내용이 실질적으로 동일한지 확인
      const normalizeContent = (content: string) => content.trim().replace(/\s+/g, ' ');
      const normalizedNodeContent = normalizeContent(nodeContent);
      const normalizedUpdatedContent = normalizeContent(finalUpdatedNodeContentForUpdate);
      
      hasChanges = normalizedNodeContent !== normalizedUpdatedContent;
      
      if (!hasChanges) {
        // 변경 사항이 없을 때는 현재 내용과 함께 "변경 없음" 메시지 표시
        diffBlock = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Current Content (No Changes Required):*\n\`\`\`${oldSlackText.substring(0, Math.min(oldSlackText.length, 800))}\`\`\`\n\n_This section is already up-to-date with the provided knowledge._`,
          },
        };
      } else {
        diffBlock = createDiffBlock(oldSlackText, newSlackText);
      }
      
      oldSlackTextForComparison = oldSlackText;
      newSlackTextForComparison = newSlackText;

      console.log('[processDocument] AI chose UPDATE action, has changes:', hasChanges);
    }

    // 메시지 정보 추출 및 중복 제거
    const uniqueMessageInfo = Array.from(
      new Map(
        validMessages.map((msg) => [
          `${msg.user || msg.bot_id}-${msg.ts}-${msg.text}`,
          {
            userId: msg.user || msg.bot_id || 'unknown',
            text: msg.text || '',
            ts: msg.ts || '',
            username: msg.username || 'Unknown',
          },
        ]),
      ).values(),
    );

    const result: ProcessedDocument = {
      fileName,
      githubUrl: doc.metadata.githubUrl,
      sectionName: doc.metadata.sectionName || '',
      headingPath: doc.metadata.headingPath,
      nodeId,
      nodeContent, // APPEND 시에는 마지막 노드의 내용, UPDATE 시에는 원본 노드의 내용
      updatedNodeContent: suggestionType === 'UPDATE' ? finalUpdatedNodeContentForUpdate : nodeContent, // APPEND 시에는 원본 노드 내용 유지
      diffBlock,
      oldContent: oldSlackTextForComparison.substring(0, Math.min(oldSlackTextForComparison.length, 1500)),
      newContent: newSlackTextForComparison.substring(0, Math.min(newSlackTextForComparison.length, 1500)),
      messages: uniqueMessageInfo,
      hasChanges,
      suggestionType,
    };

    if (suggestionType === 'APPEND') {
      result.originalLastNodeContent = nodeContent;
      result.appendedNodeContent = appendedText;

      // 새 섹션 제안 생성을 위해 모든 마크다운 파일 목록 가져오기
      const allMarkdownFiles = vectorStore.getAllMarkdownFiles();
      const availableFiles = allMarkdownFiles.map((file) => ({
        fileName: file.name,
        githubUrl: file.githubUrl,
        description: `${file.name} - Documentation file`,
      }));

      result.newSectionSuggestion = await createNewSectionFromKnowledge(knowledgeContent, availableFiles);
    }

    // --- 로깅 추가 ---
    console.log('[processDocument] Suggestion Type:', suggestionType);
    console.log('[processDocument] Has Changes:', hasChanges);
    console.log('[processDocument] For node ID:', nodeId);
    if (suggestionType === 'APPEND') {
      console.log('[processDocument] Original Node Content (for APPEND):', nodeContent);
      console.log('[processDocument] Generated Appended Text:', appendedText);
    } else {
      console.log('[processDocument] Original Node Content (for UPDATE):', nodeContent);
      console.log('[processDocument] LLM Edited Content (for UPDATE):', finalUpdatedNodeContentForUpdate);
    }
    console.log('[processDocument] Generated Diff Block (for Slack):');
    console.dir(diffBlock, { depth: null }); // diffBlock 객체를 자세히 보기 위해 console.dir 사용
    // --- 로깅 끝 ---

    return result;
  } catch (error) {
    console.error('문서 처리 중 오류 발생:', error);
    return null;
  }
}
