import * as fs from 'fs';
import { Renderer, marked } from 'marked';
import type { Tokens as MarkedTokens } from 'marked';
import type { Heading, ListItem, Paragraph, Root, Text } from 'mdast';
import { toString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { Node, Parent } from 'unist';
import { is } from 'unist-util-is';
import { visit } from 'unist-util-visit';
import { v4 as uuidv4 } from 'uuid';

/**
 * 확장된 MDAST 노드 인터페이스 - 커스텀 속성 추가
 */
export interface ExtendedNode extends Node {
  id?: string;
  parentId?: string;
  sectionId?: string;
  sectionLevel?: number;
  isListItem?: boolean;
  listItemIndex?: number;
  fileName?: string;
}

/**
 * 문서 트리 전체를 나타내는 인터페이스
 */
export interface DocumentTree {
  title: string;
  root: Root & ExtendedNode;
  // 빠른 조회를 위한 맵
  nodeMap: Map<string, ExtendedNode>;
  sectionMap: Map<string, ExtendedNode>;
}

/**
 * 노드에 고유 ID 부여하는 함수 - UUID 사용으로 100% 유니크 보장
 */
function generateNodeId(node: Node, prefix = ''): string {
  const type = node.type;
  const uuid = uuidv4().replace(/-/g, '').substring(0, 8); // 짧은 UUID

  return `${prefix}${type}-${uuid}`;
}

/**
 * AST 노드를 마크다운 형식으로 변환 (링크 등 유지, 이스케이프 방지)
 */
function nodeToMarkdown(node: any): string {
  if (!node) return '';

  if (node.type === 'text') {
    return node.value || '';
  }

  if (node.type === 'link') {
    const text = node.children ? node.children.map((child: any) => nodeToMarkdown(child)).join('') : '';
    const url = node.url || '';
    return `[${text}](${url})`;
  }

  if (node.type === 'strong') {
    const text = node.children ? node.children.map((child: any) => nodeToMarkdown(child)).join('') : '';
    return `**${text}**`;
  }

  if (node.type === 'emphasis') {
    const text = node.children ? node.children.map((child: any) => nodeToMarkdown(child)).join('') : '';
    return `*${text}*`;
  }

  if (node.type === 'inlineCode') {
    return `\`${node.value || ''}\``;
  }

  // 기본적으로 자식 노드들을 재귀적으로 처리
  if (node.children && Array.isArray(node.children)) {
    return node.children.map((child: any) => nodeToMarkdown(child)).join('');
  }

  return node.value || '';
}

/**
 * 마크다운을 파싱하여 DocumentTree로 변환
 */
export function parseMarkdownToTree(markdown: string, fileName?: string): DocumentTree {
  // 마크다운을 MDAST로 파싱
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree) => {
      // 단락과 리스트 아이템의 내용을 하나의 텍스트로 처리
      visit(tree, ['paragraph', 'listItem'], (node: any) => {
        // 노드가 리스트 아이템인 경우, 첫 번째 paragraph 자식을 찾음
        if (node.type === 'listItem') {
          const paragraphNode = node.children.find((child: any) => child.type === 'paragraph');
          if (paragraphNode) {
            // paragraph의 전체 내용을 마크다운 형식으로 변환 (링크 유지)
            const fullText = nodeToMarkdown(paragraphNode);
            // paragraph의 자식을 단일 텍스트 노드로 교체
            paragraphNode.children = [
              {
                type: 'text',
                value: fullText,
              },
            ];
          }
        } else {
          // 일반 단락인 경우도 마크다운 형식으로 변환
          const fullText = nodeToMarkdown(node);
          node.children = [
            {
              type: 'text',
              value: fullText,
            },
          ];
        }
      });

      return tree;
    });

  const root = processor.runSync(processor.parse(markdown)) as Root;

  // 문서 트리 초기화
  const docTree: DocumentTree = {
    title: '',
    root: root as Root & ExtendedNode,
    nodeMap: new Map<string, ExtendedNode>(),
    sectionMap: new Map<string, ExtendedNode>(),
  };

  // 트리 순회하며 노드 ID 부여 및 관계 설정
  let sectionCount = 0;
  let currentSection: ExtendedNode | null = null;
  const sectionStack: ExtendedNode[] = [];

  visit(root, (node, index, parent) => {
    // 노드를 확장 노드로 변환
    const extNode = node as ExtendedNode;

    // 노드에 고유 ID 부여
    extNode.id = generateNodeId(node);

    // fileName 설정
    if (fileName) {
      extNode.fileName = fileName;
    }

    // 부모 ID 설정
    if (parent) {
      extNode.parentId = (parent as ExtendedNode).id;
    }

    // 섹션 처리 (heading)
    if (is(node, 'heading')) {
      const heading = node as Heading & ExtendedNode;

      // 모든 헤딩(h1-h6)을 섹션으로 처리
      sectionCount++;
      heading.sectionId = `section-${sectionCount}`;
      heading.sectionLevel = heading.depth;

      // 섹션 스택 관리
      while (sectionStack.length > 0 && (sectionStack[sectionStack.length - 1] as Heading).depth >= heading.depth) {
        sectionStack.pop();
      }

      // 상위 섹션 ID 설정
      if (sectionStack.length > 0) {
        heading.parentId = sectionStack[sectionStack.length - 1].id;
      }

      sectionStack.push(heading);
      currentSection = heading;

      // 섹션 맵에 추가
      docTree.sectionMap.set(heading.sectionId, heading);
    }

    // 리스트 아이템 처리
    if (is(node, 'listItem')) {
      const listItem = node as ListItem & ExtendedNode;
      listItem.isListItem = true;

      // 부모 리스트의 자식 중 현재 아이템 인덱스 찾기
      if (parent && is(parent, 'list') && index !== null) {
        listItem.listItemIndex = index;
      }

      // 현재 리스트 아이템이 속한 섹션 ID 설정
      if (currentSection) {
        listItem.sectionId = currentSection.sectionId;
      }
    }

    // 일반 콘텐츠 노드 (단락 등)
    if (is(node, 'paragraph') || is(node, 'code') || is(node, 'blockquote')) {
      // 현재 노드가 속한 섹션 ID 설정
      if (currentSection) {
        extNode.sectionId = currentSection.sectionId;
      }
    }

    // 노드맵에 추가
    docTree.nodeMap.set(extNode.id, extNode);
  });

  return docTree;
}

/**
 * DocumentTree를 마크다운으로 변환
 */
export function treeToMarkdown(docTree: DocumentTree): string {
  // 커스텀 AST to Markdown 변환
  function astToMarkdown(node: any, depth = 0): string {
    if (!node) return '';

    const indent = '  '.repeat(depth);

    switch (node.type) {
      case 'root':
        return node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n\n') : '';

      case 'heading':
        const headingLevel = '#'.repeat(node.depth || 1);
        const headingText = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';
        return `${headingLevel} ${headingText}`;

      case 'paragraph':
        const paragraphText = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';
        return paragraphText;

      case 'list':
        const listItems = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n')
          : '';
        return listItems;

      case 'listItem':
        const bullet = node.ordered ? '1.' : '-';
        const itemContent = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';

        // If itemContent already starts with a list marker, use it as is
        if (itemContent.match(/^-\s+/)) {
          return `${indent}${itemContent}`;
        }

        return `${indent}${bullet} ${itemContent}`;

      case 'blockquote':
        const quoteContent = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n')
          : '';
        return quoteContent
          .split('\n')
          .map((line: string) => `> ${line}`)
          .join('\n');

      case 'code':
        const language = node.lang || '';
        const codeContent = node.value || '';
        return `\`\`\`${language}\n${codeContent}\n\`\`\``;

      case 'text':
        return node.value || '';

      case 'strong':
        const strongText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        return `**${strongText}**`;

      case 'emphasis':
        const emphasisText = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';
        return `*${emphasisText}*`;

      case 'inlineCode':
        return `\`${node.value || ''}\``;

      case 'link':
        const linkText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        const linkUrl = node.url || '';
        return `[${linkText}](${linkUrl})`;

      case 'thematicBreak':
        return '---';

      default:
        // 알 수 없는 노드 타입의 경우 자식을 처리
        if (node.children && Array.isArray(node.children)) {
          return node.children.map((child: any) => astToMarkdown(child, depth)).join('');
        }
        return node.value || '';
    }
  }

  const markdown = astToMarkdown(docTree.root);

  // 빈 줄 정리
  return markdown
    .replace(/\n{3,}/g, '\n\n') // 3개 이상의 연속 줄바꿈을 2개로
    .trim();
}

/**
 * 특정 노드 찾기
 */
export function findNodeById(docTree: DocumentTree, id: string): ExtendedNode | undefined {
  return docTree.nodeMap.get(id);
}

/**
 * 섹션 노드 찾기
 */
export function findSectionById(docTree: DocumentTree, sectionId: string): ExtendedNode | undefined {
  return docTree.sectionMap.get(sectionId);
}

/**
 * 섹션 내 모든 콘텐츠 노드 찾기
 */
export function findNodesInSection(docTree: DocumentTree, sectionId: string): ExtendedNode[] {
  const result: ExtendedNode[] = [];

  docTree.nodeMap.forEach((node) => {
    if (node.sectionId === sectionId) {
      result.push(node);
    }
  });

  return result;
}

/**
 * 노드 내용 업데이트 - 불변성 원칙을 준수하여 새로운 트리 반환
 */
export function updateNodeContent(docTree: DocumentTree, nodeId: string, newContent: string): DocumentTree {
  // 원본 트리의 깊은 복사본 생성
  const newTree: DocumentTree = {
    title: docTree.title,
    nodeMap: new Map(docTree.nodeMap),
    sectionMap: new Map(docTree.sectionMap),
    root: JSON.parse(JSON.stringify(docTree.root)),
  };

  const node = newTree.nodeMap.get(nodeId);
  if (!node) return newTree; // 노드가 없으면 변경되지 않은 복사본 반환

  // 노드 깊은 복사
  const nodeCopy = JSON.parse(JSON.stringify(node));

  let updated = false;

  if (is(nodeCopy, 'paragraph')) {
    // 단락 노드의 경우 텍스트 자식 업데이트
    const para = nodeCopy as Paragraph & ExtendedNode;
    const textNode = para.children[0] as Text;
    if (textNode) {
      textNode.value = newContent;
      updated = true;
    }
  } else if (is(nodeCopy, 'heading')) {
    // 헤딩 노드의 경우 텍스트 자식 업데이트
    const heading = nodeCopy as Heading & ExtendedNode;
    const textNode = heading.children[0] as Text;
    if (textNode) {
      textNode.value = newContent;
      updated = true;
    }
  } else if (is(nodeCopy, 'listItem')) {
    // 리스트 아이템의 경우 첫 번째 단락 업데이트
    const listItem = nodeCopy as ListItem & ExtendedNode;
    const firstChild = listItem.children[0];
    if (is(firstChild, 'paragraph')) {
      const para = firstChild as Paragraph;
      const textNode = para.children[0] as Text;
      if (textNode) {
        textNode.value = newContent;
        updated = true;
      }
    }
  }

  if (updated) {
    // 변경된 노드로 교체
    newTree.nodeMap.set(nodeId, nodeCopy);

    // 부모 노드들과 루트 트리 구조 업데이트
    updateNodeInRootTree(newTree, nodeCopy);

    console.log(`노드 ID ${nodeId} 업데이트 성공 - 새 트리 생성됨`);
  }

  return newTree;
}

/**
 * 노드를 root 트리 구조에서도 업데이트
 */
function updateNodeInRootTree(tree: DocumentTree, node: ExtendedNode): void {
  console.log(`[DEBUG] updateNodeInRootTree: 루트 트리 업데이트 시작`, { nodeId: node.id, nodeType: node.type });

  // 노드가 root 트리에 있는 실제 노드 찾기
  function findAndUpdateNodeInRoot(rootNode: Parent & ExtendedNode, targetId: string): boolean {
    // 현재 노드가 대상 노드인지 확인
    if (rootNode.id === targetId) {
      // 현재 노드를 찾았으므로 업데이트 (이 경우는 루트 자체가 대상인 드문 경우)
      Object.assign(rootNode, node);
      console.log(`[DEBUG] updateNodeInRootTree: 루트에서 직접 노드 업데이트`, { targetId });
      return true;
    }

    // 자식 노드가 없으면 종료
    if (!rootNode.children || !Array.isArray(rootNode.children)) {
      return false;
    }

    // 자식 노드들을 순회하며 대상 노드 찾기
    for (let i = 0; i < rootNode.children.length; i++) {
      const child = rootNode.children[i] as any; // any로 타입 변환하여 children 접근 가능하게 함

      // 자식이 대상 노드인 경우
      if (child.id === targetId) {
        // 자식 노드를 업데이트된 노드로 교체
        rootNode.children[i] = node;
        console.log(`[DEBUG] updateNodeInRootTree: 자식 노드 교체 완료`, { targetId, position: i });
        return true;
      }

      // 자식이 부모 노드인 경우 재귀적으로 탐색
      if (child.children && Array.isArray(child.children)) {
        if (findAndUpdateNodeInRoot(child as Parent & ExtendedNode, targetId)) {
          return true;
        }
      }
    }

    return false;
  }

  // root에서 노드 업데이트 시작
  if (node.id) {
    // id가 있는 경우만 업데이트 시도
    const found = findAndUpdateNodeInRoot(tree.root, node.id);
    console.log(`[DEBUG] updateNodeInRootTree: 루트 트리 업데이트 결과`, { nodeId: node.id, found });
  }

  // 기존 부모 노드 업데이트 로직 유지 (nodeMap 업데이트)
  updateParentNodes(tree, node);
}

/**
 * 부모 노드들 업데이트 (nodeMap 업데이트)
 */
function updateParentNodes(tree: DocumentTree, node: ExtendedNode): void {
  if (!node.parentId) return;

  const parentId = node.parentId;
  const parentNode = tree.nodeMap.get(parentId);

  if (!parentNode) return;

  // 부모 노드 복사
  const parentCopy = JSON.parse(JSON.stringify(parentNode));

  // 자식 노드 찾기 및 교체
  if (Array.isArray(parentCopy.children)) {
    for (let i = 0; i < parentCopy.children.length; i++) {
      if (parentCopy.children[i].id === node.id) {
        parentCopy.children[i] = node;
        break;
      }
    }

    // 업데이트된 부모 노드를 맵에 설정
    tree.nodeMap.set(parentId, parentCopy);

    // 재귀적으로 상위 부모 업데이트
    updateParentNodes(tree, parentCopy);
  }
}

/**
 * 문서에서 특정 섹션 업데이트
 */
export function updateSectionContent(
  docTree: DocumentTree,
  sectionId: string,
  contentId: string,
  newContent: string,
): string | null {
  // 섹션 검증
  const section = docTree.sectionMap.get(sectionId);
  if (!section) return null;

  // 콘텐츠 노드 검증
  const contentNode = docTree.nodeMap.get(contentId);
  if (!contentNode || contentNode.sectionId !== sectionId) return null;

  // 불변 방식으로 내용 업데이트
  const updatedTree = updateNodeContent(docTree, contentId, newContent);

  // 변경이 있었는지 확인 (참조가 다르면 변경된 것)
  if (updatedTree !== docTree) {
    // 전체 마크다운으로 변환
    return treeToMarkdown(updatedTree);
  }

  return null;
}

export async function convertMarkdownToSlackText(markdown: string): Promise<string> {
  const renderer = new Renderer();

  // 첫 번째 헤딩 발견 여부를 추적하기 위한 플래그
  let firstHeadingFound = false;

  // 수평선은 divider로 변환
  renderer.hr = () => {
    return '---\n';
  };

  // 헤딩은 Slack에서 굵은 텍스트 처리
  renderer.heading = ({ text, depth }: MarkedTokens.Heading) => {
    // 첫 번째 헤딩은 완전히 제거 (이미 UI에 표시되므로 중복 방지)
    if (!firstHeadingFound) {
      firstHeadingFound = true;
      return ''; // 첫 번째 헤딩 제거
    }

    // 나머지 헤딩은 기존대로 처리
    if (depth <= 2) {
      return `*${text}*\n\n`;
    }
    return `${text}\n\n`;
  };

  // 링크는 링크 텍스트만 표시 (URL 제거)
  renderer.link = ({ text }: MarkedTokens.Link) => {
    return text;
  };

  // HTML을 제거 - HTML 태그를 완전히 제거하고 내용만 유지
  renderer.html = ({ text }: MarkedTokens.HTML) => {
    // HTML 태그를 제거하고 내부 텍스트만 유지
    return text.replace(/<[^>]*>([^<]*)<\/[^>]*>/g, '$1').replace(/<[^>]*>/g, '');
  };

  // 목록
  renderer.list = ({ items, ordered }: MarkedTokens.List) => {
    return (
      items
        .map((item, index) => {
          const bullet = ordered ? `${index + 1}.` : '•';
          return `${bullet} ${item.text}`;
        })
        .join('\n') + '\n\n'
    );
  };

  // 코드 블록
  renderer.code = ({ text }: MarkedTokens.Code) => {
    return `\`\`\`${text}\`\`\`\n`;
  };

  // 인라인 코드
  renderer.codespan = ({ text }: MarkedTokens.Codespan) => {
    return `\`${text}\``;
  };

  // 강조 (bold)
  renderer.strong = ({ text }: MarkedTokens.Strong) => {
    return `*${text}*`;
  };

  // 이탤릭
  renderer.em = ({ text }: MarkedTokens.Em) => {
    return `_${text}_`;
  };

  // 일반 텍스트
  renderer.text = ({ text }: MarkedTokens.Text) => {
    return text;
  };

  // 단락 처리 - 기본 단락 마커를 제거하고 줄바꿈만 유지
  renderer.paragraph = ({ text }: MarkedTokens.Paragraph) => {
    return `${text}\n\n`;
  };

  let slackText = await marked.parse(markdown, {
    renderer,
    gfm: true,
    breaks: true,
  });

  // HTML 태그 제거 추가 처리
  slackText = slackText.replace(/<[^>]*>([^<]*)<\/[^>]*>/g, '$1').replace(/<[^>]*>/g, '');

  // 여러 개의 연속된 줄바꿈을 최대 2개로 정리
  slackText = slackText.replace(/\n{3,}/g, '\n\n');

  // 마크다운 볼드(**) 를 Slack 볼드(*)로 변환
  slackText = slackText.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  return slackText.trim();
}

/**
 * documentUpdates를 사용하여 docTree를 업데이트하고 마크다운으로 변환
 */
export function updateDocTreeWithChanges(docTree: DocumentTree, documentUpdates: any[]): string {
  let updatedTree = docTree;

  // 각 업데이트에 대해 docTree 업데이트
  for (const update of documentUpdates) {
    if (update.nodeId && update.updatedNodeContent) {
      updatedTree = updateNodeContent(updatedTree, update.nodeId, update.updatedNodeContent);
    }
  }

  // 업데이트된 트리를 마크다운으로 변환
  return treeToMarkdown(updatedTree);
}

/**
 * 임베딩을 위한 마크다운 전처리
 * 마크다운 링크에서 텍스트만 추출하고 URL 제거
 */
export function preprocessMarkdownForEmbedding(markdown: string): string {
  let processed = markdown;

  // 마크다운 링크 [텍스트](URL)를 텍스트만 남기고 제거
  processed = processed.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 일반 URL 제거 (http:// 또는 https://로 시작하는 URL)
  processed = processed.replace(/https?:\/\/[^\s<>"']+/g, '');

  // 이메일 주소 제거 (선택적)
  // processed = processed.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '');

  // 여러 공백을 하나로 정리
  processed = processed.replace(/\s+/g, ' ');

  // 앞뒤 공백 제거
  processed = processed.trim();

  return processed;
}

/**
 * 지정된 노드 바로 뒤에 새로운 sibling 노드를 추가 - APPEND 기능용
 */
export function appendNodeContent(docTree: DocumentTree, referenceNodeId: string, newContent: string): DocumentTree {
  // 원본 트리의 깊은 복사본 생성
  const newTree: DocumentTree = {
    title: docTree.title,
    nodeMap: new Map(docTree.nodeMap),
    sectionMap: new Map(docTree.sectionMap),
    root: JSON.parse(JSON.stringify(docTree.root)),
  };

  const referenceNode = newTree.nodeMap.get(referenceNodeId);
  if (!referenceNode) return newTree; // 참조 노드가 없으면 변경되지 않은 복사본 반환

  // 새 노드 생성 - 참조 노드와 같은 타입으로
  let newNode: ExtendedNode;
  const newNodeId = `${referenceNodeId}_append_${Date.now()}`;

  if (is(referenceNode, 'paragraph')) {
    // 단락 노드 생성
    newNode = {
      type: 'paragraph',
      children: [
        {
          type: 'text',
          value: newContent,
        },
      ],
      id: newNodeId,
      fileName: (referenceNode as ExtendedNode).fileName,
      parentId: (referenceNode as ExtendedNode).parentId,
      sectionId: (referenceNode as ExtendedNode).sectionId,
    } as Paragraph & ExtendedNode;
  } else if (is(referenceNode, 'listItem')) {
    // 리스트 아이템 노드 생성
    const refExtNode = referenceNode as ListItem & ExtendedNode;
    newNode = {
      type: 'listItem',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: newContent,
            },
          ],
        },
      ],
      id: newNodeId,
      fileName: refExtNode.fileName,
      parentId: refExtNode.parentId,
      sectionId: refExtNode.sectionId,
      isListItem: true,
      listItemIndex: (refExtNode.listItemIndex || 0) + 1, // 다음 인덱스
    } as ListItem & ExtendedNode;
  } else if (is(referenceNode, 'heading')) {
    // 헤딩 노드에는 직접 append할 수 없으므로, 헤딩 다음에 새로운 paragraph 추가
    const refExtNode = referenceNode as Heading & ExtendedNode;
    newNode = {
      type: 'paragraph',
      children: [
        {
          type: 'text',
          value: newContent,
        },
      ],
      id: newNodeId,
      fileName: refExtNode.fileName,
      parentId: refExtNode.parentId,
      sectionId: refExtNode.sectionId,
    } as Paragraph & ExtendedNode;
    console.log(`Heading 노드 다음에 새로운 paragraph 노드 추가: ${newNodeId}`);
  } else {
    // 지원하지 않는 노드 타입
    console.warn(`Unsupported node type for append: ${referenceNode.type}`);
    return newTree;
  }

  // 노드맵에 새 노드 추가
  newTree.nodeMap.set(newNodeId, newNode);

  // 부모 노드에서 참조 노드 바로 뒤에 새 노드 삽입
  insertNodeAfterReference(newTree, referenceNodeId, newNode);

  console.log(`새로운 ${newNode.type} 노드 (ID: ${newNodeId})가 ${referenceNodeId} 뒤에 추가되었습니다`);

  return newTree;
}

/**
 * 부모 노드에서 참조 노드 바로 뒤에 새 노드를 삽입
 */
function insertNodeAfterReference(tree: DocumentTree, referenceNodeId: string, newNode: ExtendedNode): void {
  const referenceNode = tree.nodeMap.get(referenceNodeId);
  if (!referenceNode || !referenceNode.parentId) {
    console.log(`[DEBUG] insertNodeAfterReference: 참조 노드 또는 부모 ID 없음`, {
      referenceNodeId,
      hasParentId: !!referenceNode?.parentId,
    });
    return;
  }

  const parentNode = tree.nodeMap.get(referenceNode.parentId);
  if (!parentNode || !Array.isArray((parentNode as any).children)) {
    console.log(`[DEBUG] insertNodeAfterReference: 부모 노드 또는 children 배열 없음`, {
      parentId: referenceNode.parentId,
      hasChildren: !!(parentNode as any)?.children,
    });
    return;
  }

  // 부모 노드의 자식 배열에서 참조 노드의 인덱스 찾기
  const parentChildren = (parentNode as any).children;
  const referenceIndex = parentChildren.findIndex((child: any) => child.id === referenceNodeId);

  if (referenceIndex === -1) {
    console.log(`[DEBUG] insertNodeAfterReference: 참조 노드를 부모의 children에서 찾을 수 없음`, {
      referenceNodeId,
      parentChildrenIds: parentChildren.map((c: any) => c.id || 'no-id'),
    });
    return;
  }

  console.log(`[DEBUG] insertNodeAfterReference: 새 노드 삽입 중`, {
    referenceNodeId,
    newNodeId: newNode.id,
    referenceIndex,
    parentChildrenCountBefore: parentChildren.length,
  });

  // 참조 노드 바로 뒤에 새 노드 삽입
  parentChildren.splice(referenceIndex + 1, 0, newNode);

  console.log(`[DEBUG] insertNodeAfterReference: 삽입 완료`, {
    parentChildrenCountAfter: parentChildren.length,
    newNodePosition: referenceIndex + 1,
  });

  // 리스트 아이템의 경우 인덱스 재조정
  if (is(parentNode, 'list')) {
    parentChildren.forEach((child: any, index: number) => {
      if (is(child, 'listItem')) {
        (child as ListItem & ExtendedNode).listItemIndex = index;
      }
    });
  }

  // 부모 노드 업데이트
  tree.nodeMap.set(referenceNode.parentId, parentNode);

  // 루트 트리에서도 업데이트
  updateNodeInRootTree(tree, parentNode);
  console.log(`[DEBUG] insertNodeAfterReference: 루트 트리 업데이트 완료`);
}

/**
 * 새로운 섹션을 트리에 추가 - CREATE NEW SECTION 기능용
 */
export function createNewSectionNode(
  docTree: DocumentTree,
  sectionTitle: string,
  sectionBody: string,
  insertAfterNodeId?: string, // 특정 노드 뒤에 삽입 (선택사항)
): DocumentTree {
  // 원본 트리의 깊은 복사본 생성
  const newTree: DocumentTree = {
    title: docTree.title,
    nodeMap: new Map(docTree.nodeMap),
    sectionMap: new Map(docTree.sectionMap),
    root: JSON.parse(JSON.stringify(docTree.root)),
  };

  // 새 섹션 ID 생성
  const newSectionId = `section_${Date.now()}`;

  // 헤딩 노드 생성 (섹션 제목)
  const headingNodeId = `${newSectionId}_heading`;
  const headingNode: Heading & ExtendedNode = {
    type: 'heading',
    depth: 1, // h2 레벨
    children: [{ type: 'text', value: sectionTitle }],
    id: headingNodeId,
    fileName: docTree.title || 'unknown',
    parentId: undefined, // 루트 레벨
    sectionId: newSectionId,
  };

  // 본문 노드 생성 (섹션 내용)
  const bodyNodeId = `${newSectionId}_body`;
  const bodyNode: Paragraph & ExtendedNode = {
    type: 'paragraph',
    children: [{ type: 'text', value: sectionBody }],
    id: bodyNodeId,
    fileName: docTree.title || 'unknown',
    parentId: undefined, // 루트 레벨 (헤딩과 동일한 레벨)
    sectionId: newSectionId,
  };

  // 노드맵에 추가
  newTree.nodeMap.set(headingNodeId, headingNode);
  newTree.nodeMap.set(bodyNodeId, bodyNode);

  // 섹션맵에 추가
  newTree.sectionMap.set(newSectionId, headingNode);

  // 트리 구조에 삽입
  if (insertAfterNodeId) {
    // 특정 노드 뒤에 삽입
    insertSectionAfterNode(newTree, insertAfterNodeId, headingNode, bodyNode);
  } else {
    // 문서 끝에 추가
    appendSectionToEnd(newTree, headingNode, bodyNode);
  }

  console.log(`새로운 섹션 "${sectionTitle}"이 트리에 추가되었습니다 (ID: ${newSectionId})`);

  return newTree;
}

/**
 * 특정 노드 뒤에 섹션 삽입
 */
function insertSectionAfterNode(
  tree: DocumentTree,
  referenceNodeId: string,
  headingNode: ExtendedNode,
  bodyNode: ExtendedNode,
): void {
  const referenceNode = tree.nodeMap.get(referenceNodeId);
  if (!referenceNode) {
    console.warn(`참조 노드를 찾을 수 없음: ${referenceNodeId}, 문서 끝에 추가합니다.`);
    appendSectionToEnd(tree, headingNode, bodyNode);
    return;
  }

  // 참조 노드의 부모 찾기 (없으면 루트)
  const parentNode = referenceNode.parentId ? tree.nodeMap.get(referenceNode.parentId) : tree.root;

  if (!parentNode || !Array.isArray((parentNode as any).children)) {
    console.warn(`부모 노드가 유효하지 않음, 문서 끝에 추가합니다.`);
    appendSectionToEnd(tree, headingNode, bodyNode);
    return;
  }

  const parentChildren = (parentNode as any).children;
  const referenceIndex = parentChildren.findIndex((child: any) => child.id === referenceNodeId);

  if (referenceIndex === -1) {
    console.warn(`참조 노드를 부모의 children에서 찾을 수 없음, 문서 끝에 추가합니다.`);
    appendSectionToEnd(tree, headingNode, bodyNode);
    return;
  }

  // 참조 노드 뒤에 헤딩과 본문 노드 삽입
  parentChildren.splice(referenceIndex + 1, 0, headingNode, bodyNode);

  // 부모 노드 업데이트
  if (referenceNode.parentId) {
    tree.nodeMap.set(referenceNode.parentId, parentNode);
  }

  console.log(`섹션이 노드 ${referenceNodeId} 뒤에 삽입되었습니다.`);
}

/**
 * 문서 끝에 섹션 추가
 */
function appendSectionToEnd(tree: DocumentTree, headingNode: ExtendedNode, bodyNode: ExtendedNode): void {
  // 루트 레벨에 섹션 추가
  if (Array.isArray(tree.root.children)) {
    tree.root.children.push(headingNode as any, bodyNode as any);
    console.log(`섹션이 문서 끝에 추가되었습니다.`);
  } else {
    console.error('루트 노드의 children이 배열이 아닙니다.');
  }
}

/**
 * LLM이 생성한 content를 파싱하여 개별 listItem/paragraph로 분할
 * @param content LLM이 생성한 마크다운 content
 * @returns 분할된 content 항목들의 배열
 */
export function parseAndSplitContent(content: string): Array<{ type: 'listItem' | 'paragraph'; content: string }> {
  const result: Array<{ type: 'listItem' | 'paragraph'; content: string }> = [];

  try {
    // content를 마크다운으로 파싱
    const tree = unified().use(remarkParse).parse(content);

    // root children만 순회하여 중복 방지
    if (tree.children && Array.isArray(tree.children)) {
      for (const child of tree.children) {
        if (is(child, 'paragraph')) {
          // 직접 paragraph인 경우 - 마크다운 문법 보존
          const tempRoot = { type: 'root' as const, children: [child] };
          const markdownContent = unified().use(remarkStringify).stringify(tempRoot).trim();
          if (markdownContent) {
            result.push({
              type: 'paragraph',
              content: markdownContent,
            });
          }
        } else if (is(child, 'list')) {
          // list인 경우 내부의 listItem들을 추출
          if (child.children && Array.isArray(child.children)) {
            for (const listItem of child.children) {
              if (is(listItem, 'listItem')) {
                // listItem의 실제 content만 추출 (paragraph 내용)
                if (listItem.children && listItem.children.length > 0) {
                  const paragraph = listItem.children[0];
                  if (is(paragraph, 'paragraph')) {
                    const tempRoot = { type: 'root' as const, children: [paragraph] };
                    const markdownContent = unified().use(remarkStringify).stringify(tempRoot).trim();
                    if (markdownContent) {
                      result.push({
                        type: 'listItem',
                        content: markdownContent,
                      });
                    }
                  }
                }
              }
            }
          }
        } else if (is(child, 'listItem')) {
          // 직접 listItem인 경우 - paragraph 내용만 추출
          if (child.children && child.children.length > 0) {
            const paragraph = child.children[0];
            if (is(paragraph, 'paragraph')) {
              const tempRoot = { type: 'root' as const, children: [paragraph] };
              const markdownContent = unified().use(remarkStringify).stringify(tempRoot).trim();
              if (markdownContent) {
                result.push({
                  type: 'listItem',
                  content: markdownContent,
                });
              }
            }
          }
        }
      }
    }

    // 만약 파싱된 결과가 없다면 원본 content를 paragraph로 처리
    if (result.length === 0 && content.trim()) {
      result.push({
        type: 'paragraph',
        content: content.trim(),
      });
    }
  } catch (error) {
    console.warn('Content 파싱 실패, 원본을 paragraph로 처리:', error);
    // 파싱 실패 시 원본 content를 paragraph로 처리
    if (content.trim()) {
      result.push({
        type: 'paragraph',
        content: content.trim(),
      });
    }
  }

  return result;
}

/**
 * 여러 개의 content 항목을 순차적으로 append하는 함수
 * @param docTree 문서 트리
 * @param referenceNodeId 참조 노드 ID
 * @param contentItems 분할된 content 항목들
 * @returns 업데이트된 문서 트리
 */
export function appendMultipleContents(
  docTree: DocumentTree,
  referenceNodeId: string,
  contentItems: Array<{ type: 'listItem' | 'paragraph'; content: string }>,
): DocumentTree {
  let currentTree = docTree;
  let lastInsertedNodeId = referenceNodeId;

  // 연속된 listItem들을 그룹화하여 처리
  let i = 0;
  console.log(`[DEBUG] appendMultipleContents: Processing ${contentItems.length} items`);
  while (i < contentItems.length) {
    const item = contentItems[i];
    console.log(`[DEBUG] Processing item ${i}: type=${item.type}, content="${item.content.substring(0, 30)}..."`);

    if (item.type === 'listItem') {
      // 연속된 listItem들을 수집
      const listItems = [];
      while (i < contentItems.length && contentItems[i].type === 'listItem') {
        listItems.push(contentItems[i]);
        i++;
      }

      // 연속된 listItem들을 하나의 list로 만들어서 추가
      try {
        currentTree = appendListToTree(
          currentTree,
          lastInsertedNodeId,
          listItems as Array<{ type: 'listItem'; content: string }>,
        );

        // list 노드의 ID를 찾기
        const beforeAppend = Date.now();
        const candidateIds = Array.from(currentTree.nodeMap.keys()).filter(
          (id) =>
            id.startsWith(`${lastInsertedNodeId}_append_`) &&
            Number.parseInt(id.split('_append_')[1] || '0') >= beforeAppend - 1000, // 1초 여유
        );

        if (candidateIds.length > 0) {
          const latestNodeId = candidateIds.reduce((latest, current) => {
            const latestTimestamp = Number.parseInt(latest.split('_append_')[1] || '0');
            const currentTimestamp = Number.parseInt(current.split('_append_')[1] || '0');
            return currentTimestamp > latestTimestamp ? current : latest;
          });
          lastInsertedNodeId = latestNodeId;
          console.log(`List 항목들 추가 완료: ${listItems.length}개 listItem -> 새 노드 ID: ${latestNodeId}`);
        }
      } catch (error) {
        console.error(
          `List 항목들 추가 실패:`,
          listItems.map((item) => item.content.substring(0, 20)),
          error,
        );
      }
    } else {
      // paragraph인 경우 개별 처리
      try {
        const beforeAppend = Date.now();
        currentTree = appendNodeContent(currentTree, lastInsertedNodeId, item.content);

        const candidateIds = Array.from(currentTree.nodeMap.keys()).filter(
          (id) =>
            id.startsWith(`${lastInsertedNodeId}_append_`) &&
            Number.parseInt(id.split('_append_')[1] || '0') >= beforeAppend,
        );

        if (candidateIds.length > 0) {
          const latestNodeId = candidateIds.reduce((latest, current) => {
            const latestTimestamp = Number.parseInt(latest.split('_append_')[1] || '0');
            const currentTimestamp = Number.parseInt(current.split('_append_')[1] || '0');
            return currentTimestamp > latestTimestamp ? current : latest;
          });
          lastInsertedNodeId = latestNodeId;
          console.log(`Paragraph 항목 추가 완료: "${item.content.substring(0, 50)}..." -> 새 노드 ID: ${latestNodeId}`);
        }
      } catch (error) {
        console.error(`Paragraph 항목 추가 실패: "${item.content}"`, error);
      }
      i++;
    }
  }

  return currentTree;
}

/**
 * 연속된 listItem들을 하나의 list로 만들어서 트리에 추가
 */
function appendListToTree(
  docTree: DocumentTree,
  referenceNodeId: string,
  listItems: Array<{ type: 'listItem'; content: string }>,
): DocumentTree {
  // 원본 트리의 깊은 복사본 생성
  const newTree: DocumentTree = {
    title: docTree.title,
    nodeMap: new Map(docTree.nodeMap),
    sectionMap: new Map(docTree.sectionMap),
    root: JSON.parse(JSON.stringify(docTree.root)),
  };

  const referenceNode = newTree.nodeMap.get(referenceNodeId);
  if (!referenceNode) return newTree;

  // list 노드 생성
  const listNodeId = `${referenceNodeId}_append_${Date.now()}`;
  const listNode = {
    type: 'list' as const,
    ordered: false,
    children: listItems.map((item, index) => ({
      type: 'listItem' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [
            {
              type: 'text' as const,
              value: item.content,
            },
          ],
        },
      ],
      id: `${listNodeId}_item_${index}`,
      fileName: (referenceNode as ExtendedNode).fileName,
      parentId: listNodeId,
      sectionId: (referenceNode as ExtendedNode).sectionId,
      isListItem: true,
      listItemIndex: index,
    })),
    id: listNodeId,
    fileName: (referenceNode as ExtendedNode).fileName,
    parentId: (referenceNode as ExtendedNode).parentId,
    sectionId: (referenceNode as ExtendedNode).sectionId,
  };

  // 노드맵에 list와 listItem들 추가
  newTree.nodeMap.set(listNodeId, listNode as any);
  listNode.children.forEach((listItem: any) => {
    newTree.nodeMap.set(listItem.id, listItem);
  });

  // 부모 노드에서 참조 노드 바로 뒤에 list 노드 삽입
  insertNodeAfterReference(newTree, referenceNodeId, listNode as any);

  console.log(`새로운 list 노드 (ID: ${listNodeId})가 ${listItems.length}개 listItem과 함께 추가되었습니다`);

  return newTree;
}

/**
 * 문서 트리에서 특정 노드를 제거합니다
 * @param tree 문서 트리
 * @param nodeId 제거할 노드 ID
 * @returns 업데이트된 문서 트리
 */
export function removeNodeFromTree(tree: DocumentTree, nodeId: string): DocumentTree {
  const nodeToRemove = tree.nodeMap.get(nodeId);
  if (!nodeToRemove) {
    console.warn(`Node ${nodeId} not found in tree`);
    return tree;
  }

  // 부모 노드에서 해당 노드 제거
  if (nodeToRemove.parentId) {
    const parentNode = tree.nodeMap.get(nodeToRemove.parentId);
    if (parentNode && Array.isArray((parentNode as any).children)) {
      const parentChildren = (parentNode as any).children;
      const nodeIndex = parentChildren.findIndex((child: any) => child.id === nodeId);
      if (nodeIndex !== -1) {
        parentChildren.splice(nodeIndex, 1);
        console.log(`Removed node ${nodeId} from parent ${nodeToRemove.parentId}`);
      }
    }
  } else {
    // 루트 레벨에서 제거
    if (Array.isArray(tree.root.children)) {
      const rootChildren = tree.root.children as any[];
      const nodeIndex = rootChildren.findIndex((child: any) => child.id === nodeId);
      if (nodeIndex !== -1) {
        rootChildren.splice(nodeIndex, 1);
        console.log(`Removed node ${nodeId} from root`);
      }
    }
  }

  // 노드맵에서 제거
  tree.nodeMap.delete(nodeId);
  
  // 자식 노드들도 재귀적으로 제거
  if (Array.isArray((nodeToRemove as any).children)) {
    for (const child of (nodeToRemove as any).children) {
      if (child.id) {
        tree = removeNodeFromTree(tree, child.id);
      }
    }
  }

  return tree;
}

/**
 * content 항목들을 개별 노드로 추가 (벡터 스토어용 - 각 listItem이 개별 Document가 됨)
 * @param docTree 문서 트리
 * @param referenceNodeId 참조 노드 ID (부모)
 * @param contentItems 추가할 content 항목들
 * @returns 업데이트된 문서 트리
 */
export function appendIndividualContents(
  docTree: DocumentTree,
  referenceNodeId: string,
  contentItems: Array<{ type: 'listItem' | 'paragraph'; content: string }>,
): DocumentTree {
  let currentTree = docTree;
  let lastInsertedNodeId = referenceNodeId;

  console.log(`[DEBUG] appendIndividualContents: Processing ${contentItems.length} items as individual nodes`);
  
  for (let i = 0; i < contentItems.length; i++) {
    const item = contentItems[i];
    console.log(`[DEBUG] Processing item ${i}: type=${item.type}, content="${item.content.substring(0, 30)}..."`);

    try {
      if (item.type === 'listItem') {
        // listItem을 개별 노드로 추가 (list로 감싸지 않음)
        const beforeAppend = Date.now();
        currentTree = appendListItemAsIndividualNode(currentTree, lastInsertedNodeId, item.content);
        
        // 새로 추가된 노드 ID 찾기
        const candidateIds = Array.from(currentTree.nodeMap.keys()).filter(
          (id) =>
            id.startsWith(`${lastInsertedNodeId}_append_`) &&
            Number.parseInt(id.split('_append_')[1] || '0') >= beforeAppend - 1000,
        );

        if (candidateIds.length > 0) {
          const latestNodeId = candidateIds.reduce((latest, current) => {
            const latestTimestamp = Number.parseInt(latest.split('_append_')[1] || '0');
            const currentTimestamp = Number.parseInt(current.split('_append_')[1] || '0');
            return currentTimestamp > latestTimestamp ? current : latest;
          });
          lastInsertedNodeId = latestNodeId;
          console.log(`Individual listItem 추가 완료: "${item.content.substring(0, 20)}..." -> 새 노드 ID: ${latestNodeId}`);
        }
      } else {
        // paragraph인 경우 기존 방식 사용
        const beforeAppend = Date.now();
        currentTree = appendNodeContent(currentTree, lastInsertedNodeId, item.content);
        
        // 새로 추가된 노드 ID 찾기  
        const candidateIds = Array.from(currentTree.nodeMap.keys()).filter(
          (id) =>
            id.startsWith(`${lastInsertedNodeId}_append_`) &&
            Number.parseInt(id.split('_append_')[1] || '0') >= beforeAppend - 1000,
        );

        if (candidateIds.length > 0) {
          const latestNodeId = candidateIds.reduce((latest, current) => {
            const latestTimestamp = Number.parseInt(latest.split('_append_')[1] || '0');
            const currentTimestamp = Number.parseInt(current.split('_append_')[1] || '0');
            return currentTimestamp > latestTimestamp ? current : latest;
          });
          lastInsertedNodeId = latestNodeId;
          console.log(`Individual paragraph 추가 완료: "${item.content.substring(0, 20)}..." -> 새 노드 ID: ${latestNodeId}`);
        }
      }
    } catch (error) {
      console.error(
        `Individual content 추가 실패: type=${item.type}, content="${item.content.substring(0, 20)}..."`,
        error,
      );
    }
  }

  return currentTree;
}

/**
 * listItem을 개별 노드로 추가 (list로 감싸지 않음)
 */
function appendListItemAsIndividualNode(
  docTree: DocumentTree,
  referenceNodeId: string,
  content: string,
): DocumentTree {
  // content를 마크다운으로 파싱하여 listItem 노드 생성
  const tree = unified().use(remarkParse).parse(`- ${content}`);
  
  if (tree.children && tree.children.length > 0) {
    const listNode = tree.children[0];
    if (is(listNode, 'list') && listNode.children && listNode.children.length > 0) {
      const listItemNode = listNode.children[0];
      if (is(listItemNode, 'listItem')) {
        // 개별 listItem 노드를 트리에 추가
        return appendParsedNodeToTree(docTree, referenceNodeId, listItemNode, 'listItem');
      }
    }
  }
  
  throw new Error(`Failed to parse listItem content: ${content}`);
}

/**
 * 파싱된 노드를 트리에 추가
 */
function appendParsedNodeToTree(
  docTree: DocumentTree,
  referenceNodeId: string,
  nodeToAdd: any,
  nodeType: string,
): DocumentTree {
  // 원본 트리의 깊은 복사본 생성
  const newTree: DocumentTree = {
    title: docTree.title,
    nodeMap: new Map(docTree.nodeMap),
    sectionMap: new Map(docTree.sectionMap),
    root: JSON.parse(JSON.stringify(docTree.root)),
  };

  const referenceNode = newTree.nodeMap.get(referenceNodeId);
  if (!referenceNode || !referenceNode.id) return newTree;

  // 새 노드 ID 생성
  const timestamp = Date.now();
  const newNodeId = `${referenceNodeId}_append_${timestamp}`;

  // 노드 복사 및 ID 설정
  const newNode = JSON.parse(JSON.stringify(nodeToAdd));
  newNode.id = newNodeId;
  newNode.parentId = referenceNode.parentId || referenceNode.id;
  newNode.sectionId = referenceNode.sectionId;

  // 자식 노드들에도 ID 설정 (재귀적으로)
  const referenceSectionId = referenceNode.sectionId;
  function assignIds(node: any, parentId: string) {
    if (node.children && Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        child.id = `${parentId}_child_${i}`;
        child.parentId = parentId;
        child.sectionId = referenceSectionId;
        assignIds(child, child.id);
      }
    }
  }
  assignIds(newNode, newNodeId);

  // 부모 노드의 children 배열에 추가
  const parentNodeId = referenceNode.parentId || referenceNode.id;
  const parentNode = parentNodeId ? newTree.nodeMap.get(parentNodeId) : null;
  if (parentNode && Array.isArray((parentNode as any).children)) {
    const parentChildren = (parentNode as any).children;
    
    // 참조 노드 다음 위치에 삽입
    const referenceIndex = parentChildren.findIndex((child: any) => child.id === referenceNodeId);
    if (referenceIndex !== -1) {
      parentChildren.splice(referenceIndex + 1, 0, newNode);
    } else {
      parentChildren.push(newNode);
    }
  } else if (!referenceNode.parentId) {
    // 루트 레벨에 추가
    if (Array.isArray(newTree.root.children)) {
      const rootChildren = newTree.root.children as any[];
      const referenceIndex = rootChildren.findIndex((child: any) => child.id === referenceNodeId);
      if (referenceIndex !== -1) {
        rootChildren.splice(referenceIndex + 1, 0, newNode);
      } else {
        rootChildren.push(newNode);
      }
    }
  }

  // 새 노드를 nodeMap에 추가
  newTree.nodeMap.set(newNodeId, newNode);

  // 자식 노드들도 nodeMap에 추가 (재귀적으로)
  function addToNodeMap(node: any) {
    if (node.id) {
      newTree.nodeMap.set(node.id, node);
    }
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        addToNodeMap(child);
      }
    }
  }
  addToNodeMap(newNode);

  console.log(`새 ${nodeType} 노드 추가: ${newNodeId}`);
  return newTree;
}
