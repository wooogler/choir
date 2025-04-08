import { Document } from "@langchain/core/documents";
import type { ExtendedNode, DocumentTree } from "./markdown";
import { is } from "unist-util-is";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import type {
  Heading,
  ListItem,
  Paragraph,
  Code,
  BlockContent,
  Root,
  Table,
} from "mdast";
import type { Node, Parent } from "unist";

// 청크 크기 설정
const MAX_CHUNK_SIZE = 1500;
const MIN_CHUNK_SIZE = 50;
const OPTIMAL_CHUNK_SIZE = 1000;

// 확장된 메타데이터 인터페이스
export interface DocumentMetadata {
  fileName: string;
  nodeId: string;
  sectionId?: string;
  nodeType: string;
  githubUrl: string;
  listItemIndex?: number;
  headingPath?: string[]; // 계층적 헤딩 경로
  ancestors?: string[]; // 상위 노드 IDs
  depth?: number; // 문서 구조 깊이
  chunkIndex?: number; // 청크 인덱스
  totalChunks?: number; // 총 청크 수
  importance?: number; // 중요도 점수 (0-1)
  entityMentions?: string[]; // 추출된 주요 엔티티
  codeLanguage?: string; // 코드 블록 언어
}

/**
 * DocumentTree에서 RAG에 최적화된 Document 객체들을 생성합니다.
 * 의미 구조 보존, 계층적 문맥 추가, 적응형 청킹 등의 전략을 사용합니다.
 */
export function createDocumentsFromTree(
  docTree: DocumentTree,
  fileName: string,
  githubUrl: string
): Document<DocumentMetadata>[] {
  const documents: Document<DocumentMetadata>[] = [];

  // 1. 부모-자식 관계 맵 구축
  const nodeParentMap = buildParentChildMap(docTree);

  // 2. 헤딩 맵 구축 (섹션ID -> 헤딩텍스트)
  const headingMap = new Map<string, string>();

  // 3. 섹션ID -> 헤딩노드 맵 구축
  const sectionToHeadings = new Map<string, ExtendedNode[]>();

  // 헤딩 정보 수집
  visit(docTree.root, "heading", (node) => {
    const headingNode = node as Heading & ExtendedNode;
    if (headingNode.depth > 1 && headingNode.sectionId && headingNode.id) {
      const headingText = toString(headingNode);
      headingMap.set(headingNode.sectionId, headingText);

      // 섹션별 헤딩 노드 수집
      if (!sectionToHeadings.has(headingNode.sectionId)) {
        sectionToHeadings.set(headingNode.sectionId, []);
      }
      sectionToHeadings.get(headingNode.sectionId)!.push(headingNode);
    }
  });

  // 모든 노드를 순회하며 리프 노드(콘텐츠 포함하는)에 대해 Document 생성
  visit(docTree.root, (node: ExtendedNode) => {
    if (!node.id) return; // ID가 없는 노드는 처리하지 않음

    // ID가 있는 노드만 처리되므로 nodeId는 항상 string입니다
    const nodeId = node.id as string;

    // 노드의 조상 노드들 찾기
    const ancestors = getAncestorNodes(node, nodeParentMap);

    // 헤딩 경로 구성
    const headingPath = getHeadingPathForNode(
      node,
      ancestors,
      headingMap,
      sectionToHeadings
    );

    // 중요도 점수 계산
    const importance = calculateImportance(node, ancestors, headingPath);

    // 중복 임베딩 방지: 직접적인 부모가 listItem인 paragraph는 건너뜀
    if (is(node, "paragraph") && ancestors.length > 0) {
      const immediateParent = ancestors[ancestors.length - 1];
      if (is(immediateParent, "listItem")) {
        return; // listItem 내부의 paragraph는 건너뜀
      }
    }

    // 섹션 헤딩인 경우 (Context를 추가하기 위한 특별 처리)
    if (is(node, "heading")) {
      const headingNode = node as Heading & ExtendedNode;
      const headingText = toString(headingNode);

      // 섹션 헤딩은 documents에 추가하지 않음
      // documents.push(
      //   new Document({
      //     pageContent: headingText,
      //     metadata: {
      //       fileName,
      //       nodeId,
      //       sectionId: headingNode.sectionId,
      //       nodeType: "heading",
      //       githubUrl,
      //       headingPath,
      //       ancestors: ancestors.map((a) => a.id as string),
      //       depth: ancestors.length,
      //       importance: importance + 0.1, // 헤딩은 중요도 가중치 추가
      //     },
      //   })
      // );
      return;
    }

    // 단락 노드 처리
    if (is(node, "paragraph")) {
      const paraNode = node as Paragraph & ExtendedNode;
      const text = toString(paraNode);
      if (!text.trim()) return; // 빈 단락은 건너뜀

      // 계층적 문맥 구성
      const contextPrefix = formatHeadingContext(headingPath);

      // 엔티티 추출
      const entities = extractEntities(text);

      // 콘텐츠 구성
      const fullContent = `${contextPrefix}${text}`;

      // 적응형 청킹 적용
      const chunks = adaptiveChunking(
        fullContent,
        node.type,
        OPTIMAL_CHUNK_SIZE
      );

      // 각 청크마다 Document 생성
      chunks.forEach((chunk, index) => {
        documents.push(
          new Document({
            pageContent: chunk,
            metadata: {
              fileName,
              nodeId,
              sectionId: paraNode.sectionId,
              nodeType: "paragraph",
              githubUrl,
              headingPath,
              ancestors: ancestors.map((a) => a.id as string),
              depth: ancestors.length,
              chunkIndex: chunks.length > 1 ? index : undefined,
              totalChunks: chunks.length > 1 ? chunks.length : undefined,
              importance,
              entityMentions: entities,
            },
          })
        );
      });
      return;
    }

    // 리스트 아이템 처리
    if (is(node, "listItem")) {
      const listItemNode = node as ListItem & ExtendedNode;
      const text = toString(listItemNode);
      if (!text.trim()) return; // 빈 리스트 아이템은 건너뜀

      // 계층적 문맥 구성
      const contextPrefix = formatHeadingContext(headingPath);

      // 엔티티 추출
      const entities = extractEntities(text);

      // 콘텐츠 구성 (리스트 아이템은 일반적으로 짧아서 청킹하지 않음)
      const fullContent = `${contextPrefix}${text}`;

      documents.push(
        new Document({
          pageContent: fullContent,
          metadata: {
            fileName,
            nodeId,
            sectionId: listItemNode.sectionId,
            nodeType: "listItem",
            listItemIndex: listItemNode.listItemIndex,
            githubUrl,
            headingPath,
            ancestors: ancestors.map((a) => a.id as string),
            depth: ancestors.length,
            importance: importance + 0.05, // 리스트 아이템은 약간 중요도 증가
            entityMentions: entities,
          },
        })
      );
      return;
    }

    // 코드 블록 처리
    if (is(node, "code")) {
      const codeNode = node as Code & ExtendedNode;
      const text = codeNode.value;
      if (!text.trim()) return; // 빈 코드 블록은 건너뜀

      // 계층적 문맥 구성
      const contextPrefix = formatHeadingContext(headingPath);
      const lang = codeNode.lang ? `Language: ${codeNode.lang}\n` : "";

      // 엔티티 추출 (코드에서는 함수명, 변수명 등)
      const entities = extractCodeEntities(text, codeNode.lang || "");

      // 콘텐츠 구성
      const fullContent = `${contextPrefix}${lang}${text}`;

      // 코드 블록 청킹 (함수 단위로 분리하는 것이 이상적이지만, 단순화)
      const chunks = codeNode.lang
        ? splitCodeByLogicalBlocks(
            fullContent,
            codeNode.lang,
            OPTIMAL_CHUNK_SIZE
          )
        : [fullContent];

      chunks.forEach((chunk, index) => {
        documents.push(
          new Document({
            pageContent: chunk,
            metadata: {
              fileName,
              nodeId,
              sectionId: codeNode.sectionId,
              nodeType: "code",
              githubUrl,
              headingPath,
              ancestors: ancestors.map((a) => a.id as string),
              depth: ancestors.length,
              chunkIndex: chunks.length > 1 ? index : undefined,
              totalChunks: chunks.length > 1 ? chunks.length : undefined,
              importance: importance + 0.15, // 코드 블록은 중요도 높임
              entityMentions: entities,
              codeLanguage: codeNode.lang || undefined,
            },
          })
        );
      });
      return;
    }

    // 블록쿼트 처리
    if (is(node, "blockquote")) {
      const blockNode = node as BlockContent & ExtendedNode;
      const text = toString(blockNode);
      if (!text.trim()) return; // 빈 블록쿼트는 건너뜀

      // 계층적 문맥 구성
      const contextPrefix = formatHeadingContext(headingPath);

      // 엔티티 추출
      const entities = extractEntities(text);

      // 콘텐츠 구성
      const fullContent = `${contextPrefix}${text}`;

      // 블록쿼트도 적응형 청킹 적용
      const chunks = adaptiveChunking(
        fullContent,
        node.type,
        OPTIMAL_CHUNK_SIZE
      );

      chunks.forEach((chunk, index) => {
        documents.push(
          new Document({
            pageContent: chunk,
            metadata: {
              fileName,
              nodeId,
              sectionId: blockNode.sectionId,
              nodeType: "blockquote",
              githubUrl,
              headingPath,
              ancestors: ancestors.map((a) => a.id as string),
              depth: ancestors.length,
              chunkIndex: chunks.length > 1 ? index : undefined,
              totalChunks: chunks.length > 1 ? chunks.length : undefined,
              importance: importance + 0.05, // 인용구는 약간 중요도 증가
              entityMentions: entities,
            },
          })
        );
      });
      return;
    }
  });

  // 섹션별 요약 Document 생성
  // createSectionSummaryDocuments(
  //   docTree,
  //   headingMap,
  //   sectionToHeadings,
  //   fileName,
  //   githubUrl
  // ).forEach((doc) => documents.push(doc));

  return documents;
}

/**
 * 부모-자식 관계 맵 구축 함수
 */
function buildParentChildMap(docTree: DocumentTree): Map<string, ExtendedNode> {
  const parentMap = new Map<string, ExtendedNode>();

  visit(docTree.root, (node: ExtendedNode, _, parent) => {
    if (node.id && parent) {
      const parentNode = parent as ExtendedNode;
      if (parentNode.id) {
        parentMap.set(node.id, parentNode);
      }
    }
  });

  return parentMap;
}

/**
 * 노드의 조상 노드들을 찾는 함수
 */
function getAncestorNodes(
  node: ExtendedNode,
  parentMap: Map<string, ExtendedNode>
): ExtendedNode[] {
  const ancestors: ExtendedNode[] = [];
  let current: ExtendedNode | undefined = node;

  while (current && current.id) {
    const parent = parentMap.get(current.id);
    if (parent) {
      ancestors.unshift(parent); // 최상위 조상이 앞에 오도록 배치
      current = parent;
    } else {
      break;
    }
  }

  return ancestors;
}

/**
 * 노드의 헤딩 경로를 구성하는 함수
 */
function getHeadingPathForNode(
  node: ExtendedNode,
  ancestors: ExtendedNode[],
  headingMap: Map<string, string>,
  sectionToHeadings: Map<string, ExtendedNode[]>
): string[] {
  const path: string[] = [];

  // 현재 노드의 섹션 ID가 있으면 해당 섹션의 헤딩 텍스트 추가
  if (node.sectionId && headingMap.has(node.sectionId)) {
    path.push(headingMap.get(node.sectionId)!);
  }

  // 조상 노드들 중 헤딩이거나 섹션ID가 있는 노드들의 헤딩 텍스트 추가
  for (const ancestor of ancestors) {
    // 헤딩 노드인 경우
    if (is(ancestor, "heading")) {
      const headingText = toString(ancestor);
      if (!path.includes(headingText)) {
        // 중복 방지
        path.unshift(headingText);
      }
    }
    // 섹션ID가 있는 노드인 경우
    else if (ancestor.sectionId && headingMap.has(ancestor.sectionId)) {
      const headingText = headingMap.get(ancestor.sectionId)!;
      if (!path.includes(headingText)) {
        // 중복 방지
        path.unshift(headingText);
      }
    }
  }

  return path;
}

/**
 * 헤딩 경로를 포매팅하여 문맥 접두사로 만듭니다.
 * 이 함수는 계층적 헤딩 정보를 문서 콘텐츠에 추가해 RAG 성능을 향상시킬 수 있습니다.
 * @deprecated 헤딩을 접두사로 추가하는 것은 중복 표시 문제를 발생시킬 수 있음
 */
function formatHeadingContext(headingPath: string[]): string {
  // 헤딩 경로가 없거나 비어있으면 빈 문자열 반환
  if (!headingPath || headingPath.length === 0) return "";

  // 새로운 요구사항에 따라 헤딩을 콘텐츠에 포함하지 않음
  // 이 접두사는 메타데이터의 headingPath 필드에 이미 포함되어 있으므로 중복할 필요가 없음
  return "";

  // 원래 구현 (주석 처리)
  // return `${headingPath.join(" > ")}\n\n`;
}

/**
 * 텍스트에서 주요 엔티티를 추출하는 함수 (간단한 구현)
 */
function extractEntities(text: string): string[] {
  // 실제 구현에서는 NLP 기반 엔티티 추출 사용 권장
  // 여기서는 간단한 키워드 추출 로직으로 대체

  // 불용어 제거
  const stopwords = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "is",
    "are",
    "in",
    "to",
    "for",
    "of",
    "with",
    "on",
    "at",
  ]);

  // 정규식으로 단어 추출 (알파벳, 숫자, 언더스코어로 구성된 단어)
  const words = text.match(/\b[A-Za-z0-9_]{3,}\b/g) || [];

  // 중복 제거 및 불용어 필터링
  const filteredWords = [...new Set(words)]
    .filter((word) => !stopwords.has(word.toLowerCase()))
    .slice(0, 10); // 최대 10개만 사용

  return filteredWords;
}

/**
 * 코드에서 주요 엔티티(함수, 클래스, 변수 등)를 추출하는 함수
 */
function extractCodeEntities(code: string, language: string): string[] {
  const entities: string[] = [];

  // 언어별 패턴 정의
  const patterns: Record<string, RegExp[]> = {
    javascript: [
      /function\s+([A-Za-z0-9_]+)/g, // 함수 선언
      /class\s+([A-Za-z0-9_]+)/g, // 클래스 선언
      /const\s+([A-Za-z0-9_]+)/g, // 상수 선언
      /let\s+([A-Za-z0-9_]+)/g, // 변수 선언
      /var\s+([A-Za-z0-9_]+)/g, // 변수 선언 (var)
      /([A-Za-z0-9_]+)\s*=\s*function/g, // 함수 표현식
    ],
    typescript: [
      /function\s+([A-Za-z0-9_]+)/g, // 함수 선언
      /class\s+([A-Za-z0-9_]+)/g, // 클래스 선언
      /interface\s+([A-Za-z0-9_]+)/g, // 인터페이스 선언
      /type\s+([A-Za-z0-9_]+)/g, // 타입 선언
      /const\s+([A-Za-z0-9_]+)/g, // 상수 선언
      /let\s+([A-Za-z0-9_]+)/g, // 변수 선언
    ],
    python: [
      /def\s+([A-Za-z0-9_]+)/g, // 함수 선언
      /class\s+([A-Za-z0-9_]+)/g, // 클래스 선언
      /([A-Za-z0-9_]+)\s*=\s*/g, // 변수 할당
    ],
  };

  // 기본 패턴 (모든 언어에 적용)
  const defaultPatterns = [
    /\b([A-Z][A-Za-z0-9_]+)\b/g, // 파스칼 케이스 식별자 (클래스 등)
    /\b([a-z][A-Za-z0-9_]{5,})\b/g, // 카멜 케이스 식별자 5자 이상
  ];

  // 언어별 패턴 적용
  const langPatterns = patterns[language.toLowerCase()] || defaultPatterns;

  // 모든 패턴에 대해 매칭
  for (const pattern of langPatterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      if (match[1] && match[1].length > 2) {
        // 너무 짧은 식별자 제외
        entities.push(match[1]);
      }
    }
  }

  // 중복 제거 및 최대 갯수 제한
  return [...new Set(entities)].slice(0, 10);
}

/**
 * 적응형 청킹 - 텍스트를 의미 단위로 나누는 함수
 */
function adaptiveChunking(
  content: string,
  nodeType: string,
  targetSize: number
): string[] {
  if (content.length <= targetSize) return [content];

  // 노드 타입에 따라 청킹 전략 변경
  if (nodeType === "paragraph" || nodeType === "blockquote") {
    return splitTextByParagraphsAndSentences(content, targetSize);
  }

  // 기본 전략: 문단 단위로 분할
  return splitByParagraphs(content, targetSize);
}

/**
 * 텍스트를 문단과 문장 경계로 분할하는 함수
 */
function splitTextByParagraphsAndSentences(
  text: string,
  targetSize: number
): string[] {
  // 우선 문단으로 분할
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    // 문단이 너무 큰 경우 문장 단위로 추가 분할
    if (para.length > targetSize) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

      // 문장 단위로 분할
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      let sentenceChunk = "";

      for (const sentence of sentences) {
        if ((sentenceChunk + sentence).length <= targetSize) {
          sentenceChunk += sentence;
        } else {
          if (sentenceChunk) chunks.push(sentenceChunk);
          sentenceChunk = sentence;
        }
      }

      if (sentenceChunk) chunks.push(sentenceChunk);
    }
    // 적당한 크기의 문단은 청크에 추가
    else if ((currentChunk + "\n\n" + para).length <= targetSize) {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = para;
    }
  }

  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

/**
 * 코드를 논리적 블록 단위로 분할하는 함수 (언어별 최적화)
 */
function splitCodeByLogicalBlocks(
  code: string,
  language: string,
  targetSize: number
): string[] {
  if (code.length <= targetSize) return [code];

  // 언어별 분할 패턴 정의
  const blockPatterns: Record<string, RegExp> = {
    javascript: /function\s+\w+\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\n?/g,
    typescript:
      /function\s+\w+\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\n?|interface\s+\w+\s*\{[\s\S]*?\}\n?|class\s+\w+\s*\{[\s\S]*?\}\n?/g,
    python:
      /def\s+\w+\s*\([\s\S]*?\)[\s\S]*?(?:return|pass|raise).*?(?=\n\s*\n|\n\s*def|\n\s*class|$)/g,
    java: /(?:public|private|protected|static)?\s*\w+\s+\w+\s*\([\s\S]*?\)\s*\{[\s\S]*?\}\n?/g,
  };

  // 기본 분할 패턴 (일반 코드 라인 단위)
  const defaultPattern = /.*\n/g;

  // 언어별 패턴 또는 기본 패턴 사용
  const pattern = blockPatterns[language.toLowerCase()] || defaultPattern;

  // 패턴으로 블록 추출
  const blocks: string[] = [];
  let match;
  let lastIndex = 0;

  while ((match = pattern.exec(code)) !== null) {
    // 현재 블록
    const block = match[0];

    // 블록 사이에 있는 텍스트 처리
    if (match.index > lastIndex) {
      const betweenText = code.substring(lastIndex, match.index);
      if (betweenText.trim()) {
        blocks.push(betweenText);
      }
    }

    blocks.push(block);
    lastIndex = match.index + block.length;
  }

  // 남은 텍스트 처리
  if (lastIndex < code.length) {
    const remainingText = code.substring(lastIndex);
    if (remainingText.trim()) {
      blocks.push(remainingText);
    }
  }

  // 추출된 블록이 없으면 단순 라인 단위로 분할
  if (blocks.length === 0) {
    return splitByLines(code, targetSize);
  }

  // 블록들을 적절한 크기로 청킹
  return mergeBlocksToTargetSize(blocks, targetSize);
}

/**
 * 텍스트 블록들을 대상 크기에 맞게 병합하는 함수
 */
function mergeBlocksToTargetSize(
  blocks: string[],
  targetSize: number
): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const block of blocks) {
    // 블록이 이미 대상 크기보다 크면 그대로 사용
    if (block.length >= targetSize) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }
      chunks.push(block);
      continue;
    }

    // 블록을 현재 청크에 추가할 수 있는지 확인
    if (
      (currentChunk + (currentChunk ? "\n" : "") + block).length <= targetSize
    ) {
      currentChunk += (currentChunk ? "\n" : "") + block;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = block;
    }
  }

  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

/**
 * 텍스트를 문단 단위로 분할하는 함수
 */
function splitByParagraphs(text: string, targetSize: number): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    if ((currentChunk + "\n\n" + para).length <= targetSize) {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = para;
    }
  }

  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

/**
 * 텍스트를 라인 단위로 분할하는 함수
 */
function splitByLines(text: string, targetSize: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let currentChunk = "";

  for (const line of lines) {
    if ((currentChunk + "\n" + line).length <= targetSize) {
      currentChunk += (currentChunk ? "\n" : "") + line;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line;
    }
  }

  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

/**
 * 노드의 중요도 점수 계산 함수
 */
function calculateImportance(
  node: ExtendedNode,
  ancestors: ExtendedNode[],
  headingPath: string[]
): number {
  let score = 0.5; // 기본 점수

  // 깊이가 얕을수록 중요도 증가
  score += Math.max(0, 0.3 - ancestors.length * 0.05);

  // 섹션 헤딩과의 근접성
  if (node.sectionId) score += 0.1;

  // 헤딩 경로가 짧을수록 중요도 증가 (주요 섹션에 가까움)
  score += Math.max(0, 0.2 - headingPath.length * 0.05);

  // 노드 타입별 가중치
  if (is(node, "heading")) score += 0.1;
  if (is(node, "code")) score += 0.15;
  if (is(node, "listItem")) score += 0.05;

  // 최댓값 제한
  return Math.min(1, Math.max(0, score));
}

/**
 * 섹션별 요약 Document 생성 함수
 */
function createSectionSummaryDocuments(
  docTree: DocumentTree,
  headingMap: Map<string, string>,
  sectionToHeadings: Map<string, ExtendedNode[]>,
  fileName: string,
  githubUrl: string
): Document<DocumentMetadata>[] {
  const documents: Document<DocumentMetadata>[] = [];

  // 각 섹션별로 요약 Document 생성
  for (const [sectionId, headings] of sectionToHeadings.entries()) {
    if (headings.length === 0) continue;

    const headingNode = headings[0] as Heading & ExtendedNode;
    const headingText = toString(headingNode);

    // 해당 섹션에 속한 모든 노드 찾기
    const sectionNodes: ExtendedNode[] = [];
    visit(docTree.root, (node: ExtendedNode) => {
      if (node.sectionId === sectionId) {
        sectionNodes.push(node);
      }
    });

    if (sectionNodes.length === 0) continue;

    // 섹션 내용 수집
    let sectionContent = "";
    for (const node of sectionNodes) {
      if (
        is(node, "paragraph") ||
        is(node, "listItem") ||
        is(node, "blockquote")
      ) {
        sectionContent += toString(node) + "\n\n";
      } else if (is(node, "code")) {
        sectionContent += "Code Block: " + (node as Code).lang + "\n";
      }
    }

    if (!sectionContent.trim()) continue;

    // 섹션 요약 Document 생성
    documents.push(
      new Document({
        pageContent: `# ${headingText}\n\n${sectionContent.trim()}`,
        metadata: {
          fileName,
          nodeId: `section-summary-${sectionId}`,
          nodeType: "section-summary",
          sectionId,
          githubUrl,
          headingPath: [headingText],
          importance: 0.8, // 섹션 요약은 높은 중요도
          entityMentions: extractEntities(sectionContent),
        },
      })
    );
  }

  return documents;
}
