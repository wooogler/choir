import type { Document } from '@langchain/core/documents';
import type { WebClient } from '@slack/web-api';
import {
  type NewSectionSuggestion,
  createNewContentFromKnowledge,
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

    // originalContent가 있으면 사용 (순수한 내용), 없으면 pageContent에서 컨텍스트 제거
    let nodeContent = '';
    if (doc.metadata.originalContent) {
      nodeContent = doc.metadata.originalContent;
    } else {
      // pageContent에서 "File: ... Path: ..." 컨텍스트 제거
      const lines = doc.pageContent.split('\n');
      let contentStartIndex = 0;

      // "File:" 또는 "Path:"로 시작하는 라인들을 건너뜀
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('File:') || line.startsWith('Path:') || line === '') {
          contentStartIndex = i + 1;
        } else {
          break;
        }
      }

      nodeContent = lines.slice(contentStartIndex).join('\n').trim();
    }

    // 빈 섹션 처리: 빈 문자열로 시작하여 LLM이 처음부터 생성하도록 함
    if (!nodeContent) {
      nodeContent = ''; // 빈 문자열로 시작
      console.log(`[processDocument] Empty section detected, starting with blank content for nodeId: ${nodeId}`);
    }
    // 병렬로 LLM 호출: 메인 업데이트 + 새 섹션 제안
    const [llmEditedContent, newSectionSuggestion] = await Promise.all([
      editMarkdownWithKnowledge(nodeContent, knowledgeContent, {
        fileName: doc.metadata.fileName,
        sectionName: doc.metadata.sectionName,
        headingPath: doc.metadata.headingPath,
      }),
      (async () => {
        // 새 섹션 제안 생성을 위해 모든 마크다운 파일 목록 가져오기
        const allMarkdownFiles = vectorStore.getAllMarkdownFiles();
        const availableFiles = allMarkdownFiles.map((file) => ({
          fileName: file.name,
          githubUrl: file.githubUrl,
          description: `${file.name} - Documentation file`,
        }));
        return await createNewSectionFromKnowledge(knowledgeContent, availableFiles);
      })(),
    ]);

    // 단순화된 로직: 항상 UPDATE 타입으로 처리하되 diff UI 사용
    const suggestionType = 'UPDATE' as const; // 타입 통일
    const oldSlackText = await convertMarkdownToSlackText(nodeContent);
    const newSlackText = await convertMarkdownToSlackText(llmEditedContent);

    // 항상 diff 블록 생성
    const diffBlock = createDiffBlock(oldSlackText, newSlackText);
    const hasChanges = oldSlackText !== newSlackText;

    console.log('[processDocument] Using unified UPDATE approach with diff UI');
    console.log('[processDocument] Has Changes:', hasChanges);
    console.log('[processDocument] For node ID:', nodeId);

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
      nodeContent, // 원본 노드 내용
      updatedNodeContent: llmEditedContent, // LLM이 생성한 업데이트된 내용
      diffBlock,
      oldContent: oldSlackText.substring(0, Math.min(oldSlackText.length, 1500)),
      newContent: newSlackText.substring(0, Math.min(newSlackText.length, 1500)),
      messages: uniqueMessageInfo,
      hasChanges,
      suggestionType, // 항상 'UPDATE'
      newSectionSuggestion, // 항상 포함
    };

    // --- 로깅 추가 ---
    console.log('[processDocument] Suggestion Type:', suggestionType);
    console.log('[processDocument] Has Changes:', hasChanges);
    console.log('[processDocument] For node ID:', nodeId);
    console.log('[processDocument] Original Node Content:', nodeContent);
    console.log('[processDocument] LLM Edited Content:', llmEditedContent);
    console.log('[processDocument] New Section Suggestion available:', !!newSectionSuggestion);
    // --- 로깅 끝 ---

    return result;
  } catch (error) {
    console.error('문서 처리 중 오류 발생:', error);
    return null;
  }
}
