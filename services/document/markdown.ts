import { marked, Renderer } from "marked";
import type { Tokens as MarkedTokens } from "marked";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { is } from "unist-util-is";
import { toString } from "mdast-util-to-string";
import type { Root, Heading, ListItem, Paragraph, Text } from "mdast";
import type { Node, Parent } from "unist";
import * as crypto from "crypto";
import * as fs from "fs";

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
 * 노드에 고유 ID 부여하는 함수
 */
function generateNodeId(node: Node, prefix = ""): string {
  const type = node.type;
  const content = toString(node as any).slice(0, 20);
  const hash = crypto
    .createHash("md5")
    .update(`${type}-${content}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);

  return `${prefix}${type}-${hash}`;
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
            paragraphNode.children = [{
              type: 'text',
              value: fullText
            }];
          }
        } else {
          // 일반 단락인 경우도 마크다운 형식으로 변환
          const fullText = nodeToMarkdown(node);
          node.children = [{
            type: 'text',
            value: fullText
          }];
        }
      });
      
      return tree;
    });

  const root = processor.runSync(processor.parse(markdown)) as Root;

  // 문서 트리 초기화
  const docTree: DocumentTree = {
    title: "",
    root: root as Root & ExtendedNode,
    nodeMap: new Map<string, ExtendedNode>(),
    sectionMap: new Map<string, ExtendedNode>(),
  };

  // 트리 순회하며 노드 ID 부여 및 관계 설정
  let sectionCount = 0;
  let currentSection: ExtendedNode | null = null;
  let sectionStack: ExtendedNode[] = [];

  // 첫 번째 h1을 문서 제목으로 설정
  let titleFound = false;

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
    if (is(node, "heading")) {
      const heading = node as Heading & ExtendedNode;

      // 첫 번째 h1은 문서 제목으로
      if (heading.depth === 1 && !titleFound) {
        docTree.title = toString(heading);
        titleFound = true;
        return;
      }

      // h2-h6은 섹션으로 처리
      sectionCount++;
      heading.sectionId = `section-${sectionCount}`;
      heading.sectionLevel = heading.depth;

      // 섹션 스택 관리
      while (
        sectionStack.length > 0 &&
        (sectionStack[sectionStack.length - 1] as Heading).depth >=
          heading.depth
      ) {
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
    if (is(node, "listItem")) {
      const listItem = node as ListItem & ExtendedNode;
      listItem.isListItem = true;

      // 부모 리스트의 자식 중 현재 아이템 인덱스 찾기
      if (parent && is(parent, "list") && index !== null) {
        listItem.listItemIndex = index;
      }

      // 현재 리스트 아이템이 속한 섹션 ID 설정
      if (currentSection) {
        listItem.sectionId = currentSection.sectionId;
      }
    }

    // 일반 콘텐츠 노드 (단락 등)
    if (is(node, "paragraph") || is(node, "code") || is(node, "blockquote")) {
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
  function astToMarkdown(node: any, depth: number = 0): string {
    if (!node) return '';
    
    const indent = '  '.repeat(depth);
    
    switch (node.type) {
      case 'root':
        return node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n') : '';
        
      case 'heading':
        const headingLevel = '#'.repeat(node.depth || 1);
        const headingText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        return `${headingLevel} ${headingText}`;
        
      case 'paragraph':
        const paragraphText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        return paragraphText;
        
      case 'list':
        const listItems = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n') : '';
        return listItems;
        
      case 'listItem':
        const bullet = node.ordered ? '1.' : '*';
        const itemContent = node.children ? node.children.map((child: any) => astToMarkdown(child, depth + 1)).join('\n') : '';
        return `${indent}${bullet} ${itemContent}`;
        
      case 'blockquote':
        const quoteContent = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n') : '';
        return quoteContent.split('\n').map((line: string) => `> ${line}`).join('\n');
        
      case 'code':
        const language = node.lang || '';
        const codeContent = node.value || '';
        return `\`\`\`${language}\n${codeContent}\n\`\`\``;
        
      case 'text':
        return node.value || '';
        
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
    .replace(/\n{3,}/g, '\n\n')  // 3개 이상의 연속 줄바꿈을 2개로
    .trim();
}

/**
 * 특정 노드 찾기
 */
export function findNodeById(
  docTree: DocumentTree,
  id: string
): ExtendedNode | undefined {
  return docTree.nodeMap.get(id);
}

/**
 * 섹션 노드 찾기
 */
export function findSectionById(
  docTree: DocumentTree,
  sectionId: string
): ExtendedNode | undefined {
  return docTree.sectionMap.get(sectionId);
}

/**
 * 섹션 내 모든 콘텐츠 노드 찾기
 */
export function findNodesInSection(
  docTree: DocumentTree,
  sectionId: string
): ExtendedNode[] {
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
export function updateNodeContent(
  docTree: DocumentTree,
  nodeId: string,
  newContent: string
): DocumentTree {
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

  if (is(nodeCopy, "paragraph")) {
    // 단락 노드의 경우 텍스트 자식 업데이트
    const para = nodeCopy as Paragraph & ExtendedNode;
    const textNode = para.children[0] as Text;
    if (textNode) {
      textNode.value = newContent;
      updated = true;
    }
  } else if (is(nodeCopy, "heading")) {
    // 헤딩 노드의 경우 텍스트 자식 업데이트
    const heading = nodeCopy as Heading & ExtendedNode;
    const textNode = heading.children[0] as Text;
    if (textNode) {
      textNode.value = newContent;
      updated = true;
    }
  } else if (is(nodeCopy, "listItem")) {
    // 리스트 아이템의 경우 첫 번째 단락 업데이트
    const listItem = nodeCopy as ListItem & ExtendedNode;
    const firstChild = listItem.children[0];
    if (is(firstChild, "paragraph")) {
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
  // 노드가 root 트리에 있는 실제 노드 찾기
  function findAndUpdateNodeInRoot(
    rootNode: Parent & ExtendedNode,
    targetId: string
  ): boolean {
    // 현재 노드가 대상 노드인지 확인
    if (rootNode.id === targetId) {
      // 현재 노드를 찾았으므로 업데이트 (이 경우는 루트 자체가 대상인 드문 경우)
      Object.assign(rootNode, node);
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
    findAndUpdateNodeInRoot(tree.root, node.id);
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
  newContent: string
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

export async function convertMarkdownToSlackText(
  markdown: string
): Promise<string> {
  const renderer = new Renderer();

  // 첫 번째 헤딩 발견 여부를 추적하기 위한 플래그
  let firstHeadingFound = false;

  // 수평선은 divider로 변환
  renderer.hr = () => {
    return "---\n";
  };

  // 헤딩은 Slack에서 굵은 텍스트 처리
  renderer.heading = ({ text, depth }: MarkedTokens.Heading) => {
    // 첫 번째 헤딩은 완전히 제거 (이미 UI에 표시되므로 중복 방지)
    if (!firstHeadingFound) {
      firstHeadingFound = true;
      return ""; // 첫 번째 헤딩 제거
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
    return text
      .replace(/<[^>]*>([^<]*)<\/[^>]*>/g, "$1")
      .replace(/<[^>]*>/g, "");
  };

  // 목록
  renderer.list = ({ items, ordered }: MarkedTokens.List) => {
    return items.map((item, index) => {
      const bullet = ordered ? `${index + 1}.` : "•";
      return `${bullet} ${item.text}`;
    }).join("\n") + "\n\n";
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
    breaks: true
  });

  // HTML 태그 제거 추가 처리
  slackText = slackText
    .replace(/<[^>]*>([^<]*)<\/[^>]*>/g, "$1")
    .replace(/<[^>]*>/g, "");

  // 여러 개의 연속된 줄바꿈을 최대 2개로 정리
  slackText = slackText.replace(/\n{3,}/g, "\n\n");

  // 마크다운 볼드(**) 를 Slack 볼드(*)로 변환
  slackText = slackText.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  return slackText.trim();
}

/**
 * documentUpdates를 사용하여 docTree를 업데이트하고 마크다운으로 변환
 */
export function updateDocTreeWithChanges(
  docTree: DocumentTree,
  documentUpdates: any[]
): string {
  let updatedTree = docTree;

  // 각 업데이트에 대해 docTree 업데이트
  for (const update of documentUpdates) {
    if (update.nodeId && update.updatedNodeContent) {
      updatedTree = updateNodeContent(
        updatedTree,
        update.nodeId,
        update.updatedNodeContent
      );
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
