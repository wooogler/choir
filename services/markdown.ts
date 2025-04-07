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
 * 마크다운을 파싱하여 DocumentTree로 변환
 */
export function parseMarkdownToTree(markdown: string): DocumentTree {
  // 마크다운을 MDAST로 파싱
  const processor = unified().use(remarkParse);
  const root = processor.parse(markdown) as Root;

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
  // MDAST를 마크다운으로 변환
  const processor = unified().use(remarkStringify, {
    bullet: "-",
    listItemIndent: "one",
    emphasis: "_",
    strong: "**",
  } as any);

  return processor.stringify(docTree.root).toString().trim();
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

  // 헤딩은 Slack에서 굵은 텍스트 처리 - 헤딩 내용이 이미 문서에 포함되어 있어 중복될 수 있으므로 제거
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
    return `${items.map((item) => item.raw).join("\n")}\n`;
  };

  // 코드 블록
  renderer.code = ({ text }: MarkedTokens.Code) => {
    return `\`\`\`${text}\`\`\`\n`;
  };

  // 인라인 코드
  renderer.codespan = ({ text }: MarkedTokens.Codespan) => {
    return `\`${text}\``;
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
  });

  // HTML 태그 제거 추가 처리
  slackText = slackText
    .replace(/<[^>]*>([^<]*)<\/[^>]*>/g, "$1")
    .replace(/<[^>]*>/g, "");

  // 여러 개의 연속된 줄바꿈을 최대 2개로 정리
  slackText = slackText.replace(/\n{3,}/g, "\n\n");

  return slackText.trim();
}
