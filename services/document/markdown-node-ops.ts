import type { Heading, List, ListItem, Paragraph, Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Parent } from 'unist';
import type { DocumentTree, ExtendedNode } from './document-types';

/**
 * 노드를 root 트리 구조에서도 업데이트
 */
function updateNodeInRootTree(tree: DocumentTree, node: ExtendedNode): void {
  console.log('[DEBUG] updateNodeInRootTree: 루트 트리 업데이트 시작', { nodeId: node.id, nodeType: node.type });

  // 노드가 root 트리에 있는 실제 노드 찾기
  function findAndUpdateNodeInRoot(rootNode: Parent & ExtendedNode, targetId: string): boolean {
    // 현재 노드가 대상 노드인지 확인
    if (rootNode.id === targetId) {
      // 현재 노드를 찾았으므로 업데이트 (이 경우는 루트 자체가 대상인 드문 경우)
      Object.assign(rootNode, node);
      console.log('[DEBUG] updateNodeInRootTree: 루트에서 직접 노드 업데이트', { targetId });
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
        console.log('[DEBUG] updateNodeInRootTree: 자식 노드 교체 완료', { targetId, position: i });
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
    console.log('[DEBUG] updateNodeInRootTree: 루트 트리 업데이트 결과', { nodeId: node.id, found });
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
 * 새로운 섹션을 트리에 추가 - CREATE NEW SECTION 기능용
 */
export function createNewSectionNode(
  docTree: DocumentTree,
  sectionTitle: string,
  sectionBody: string,
  insertAfterNodeId?: string, // 특정 노드 뒤에 삽입 (선택사항)
): { tree: DocumentTree; newNodeIds: string[] } {
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

  // 본문을 파싱하여 여러 노드로 분할
  const contentItems = parseAndSplitContent(sectionBody);
  const bodyNodeIds: string[] = [];
  const bodyNodes: ExtendedNode[] = [];

  // 각 contentItem을 별도 노드로 생성
  for (let i = 0; i < contentItems.length; i++) {
    const item = contentItems[i];
    const timestamp = Date.now() + i; // 고유한 ID 보장
    const nodeId = `${newSectionId}_${item.type}_${timestamp}`;

    let node: ExtendedNode;

    if (item.type === 'paragraph') {
      node = {
        type: 'paragraph',
        children: [{ type: 'text', value: item.content }],
        id: nodeId,
        fileName: docTree.title || 'unknown',
        parentId: undefined, // 루트 레벨
        sectionId: newSectionId,
      } as Paragraph & ExtendedNode;
    } else if (item.type === 'listItem') {
      node = {
        type: 'listItem',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'text', value: item.content }],
          },
        ],
        id: nodeId,
        fileName: docTree.title || 'unknown',
        parentId: undefined, // 임시값, 아래에서 리스트와 연결
        sectionId: newSectionId,
        isListItem: true,
        listItemIndex: 0, // 임시값, 아래에서 재계산
      } as ListItem & ExtendedNode;
    } else if (item.type === 'list') {
      // list 타입의 경우 마크다운을 파싱해서 list 노드 생성
      try {
        const processor = unified().use(remarkParse);
        const parsedMarkdown = processor.parse(item.content) as Root;

        if (parsedMarkdown.children && parsedMarkdown.children.length > 0) {
          const listNode = parsedMarkdown.children[0] as any;
          if (listNode && listNode.type === 'list') {
            // list 노드의 children들을 처리해서 ExtendedNode로 변환
            const listChildren = listNode.children.map((child: any, childIndex: number) => {
              const childNodeId = `${nodeId}_item_${childIndex}`;
              return {
                ...child,
                id: childNodeId,
                fileName: docTree.title || 'unknown',
                parentId: nodeId,
                sectionId: newSectionId,
                isListItem: true,
                listItemIndex: childIndex,
              };
            });

            node = {
              type: 'list',
              ordered: listNode.ordered || false,
              spread: listNode.spread || false,
              children: listChildren,
              id: nodeId,
              fileName: docTree.title || 'unknown',
              parentId: undefined,
              sectionId: newSectionId,
            } as List & ExtendedNode;
          } else {
            // list가 아닌 경우 paragraph로 처리
            node = {
              type: 'paragraph',
              children: [{ type: 'text', value: item.content }],
              id: nodeId,
              fileName: docTree.title || 'unknown',
              parentId: undefined,
              sectionId: newSectionId,
            } as Paragraph & ExtendedNode;
          }
        } else {
          continue; // 빈 내용은 건너뛰기
        }
      } catch (error) {
        console.warn('List 파싱 실패, paragraph로 처리:', error);
        node = {
          type: 'paragraph',
          children: [{ type: 'text', value: item.content }],
          id: nodeId,
          fileName: docTree.title || 'unknown',
          parentId: undefined,
          sectionId: newSectionId,
        } as Paragraph & ExtendedNode;
      }
    } else {
      continue; // 지원하지 않는 타입은 건너뛰기
    }

    bodyNodes.push(node);
    bodyNodeIds.push(nodeId);
  }

  // 연속된 listItem들을 그룹화하여 list 노드로 감싸기
  const finalNodes: ExtendedNode[] = [];
  const finalNodeIds: string[] = [];

  let i = 0;
  while (i < bodyNodes.length) {
    const node = bodyNodes[i];

    if (node.type === 'listItem') {
      // 연속된 listItem들을 수집
      const listItems: (ListItem & ExtendedNode)[] = [];
      while (i < bodyNodes.length && bodyNodes[i].type === 'listItem') {
        listItems.push(bodyNodes[i] as ListItem & ExtendedNode);
        i++;
      }

      // list 노드 생성
      const listNodeId = `${newSectionId}_list_${Date.now()}`;
      const listNode = {
        type: 'list',
        ordered: false,
        children: listItems,
        id: listNodeId,
        fileName: docTree.title || 'unknown',
        parentId: undefined,
        sectionId: newSectionId,
      } as List & ExtendedNode;

      // listItem들의 parentId와 listItemIndex 설정
      for (const [index, listItem] of listItems.entries()) {
        listItem.parentId = listNodeId;
        listItem.listItemIndex = index;
      }

      finalNodes.push(listNode);
      finalNodeIds.push(listNodeId);

      // listItem들도 개별적으로 nodeMap에 추가되어야 함
      for (const listItem of listItems) {
        finalNodes.push(listItem);
        if (listItem.id) {
          finalNodeIds.push(listItem.id);
        }
      }
    } else if (node.type === 'list') {
      // list 노드는 이미 완성된 형태이므로 그대로 추가
      finalNodes.push(node);
      if (node.id) {
        finalNodeIds.push(node.id);
      }
      i++;
    } else {
      // paragraph 등 다른 노드는 그대로 추가
      finalNodes.push(node);
      if (node.id) {
        finalNodeIds.push(node.id);
      }
      i++;
    }
  }

  // 노드맵에 추가 (재귀적으로 자식 노드들도 포함)
  const addNodeToMapRecursively = (node: ExtendedNode): void => {
    if (node.id) {
      newTree.nodeMap.set(node.id, node);

      // 자식 노드들도 재귀적으로 추가 (list의 listItem들 포함)
      const nodeWithChildren = node as any;
      if (nodeWithChildren.children && Array.isArray(nodeWithChildren.children)) {
        for (const child of nodeWithChildren.children) {
          if (child.id) {
            addNodeToMapRecursively(child);
          }
        }
      }
    }
  };

  addNodeToMapRecursively(headingNode);
  for (const node of finalNodes) {
    addNodeToMapRecursively(node);
  }

  // 섹션맵에 추가
  newTree.sectionMap.set(newSectionId, headingNode);

  // 트리 구조에 삽입
  if (insertAfterNodeId) {
    // 특정 노드 뒤에 삽입
    insertSectionAfterNode(newTree, insertAfterNodeId, headingNode, finalNodes);
  } else {
    // 문서 끝에 추가
    appendSectionToEnd(newTree, headingNode, finalNodes);
  }

  console.log(`새로운 섹션 "${sectionTitle}"이 트리에 추가되었습니다 (ID: ${newSectionId})`);

  // 새로 생성된 모든 노드 ID들 반환
  return { tree: newTree, newNodeIds: [headingNodeId, ...finalNodeIds] };
}

/**
 * 특정 노드 뒤에 섹션 삽입
 */
function insertSectionAfterNode(
  tree: DocumentTree,
  referenceNodeId: string,
  headingNode: ExtendedNode,
  bodyNodes: ExtendedNode[],
): void {
  const referenceNode = tree.nodeMap.get(referenceNodeId);
  if (!referenceNode) {
    console.warn(`참조 노드를 찾을 수 없음: ${referenceNodeId}, 문서 끝에 추가합니다.`);
    appendSectionToEnd(tree, headingNode, bodyNodes);
    return;
  }

  // 참조 노드의 부모 찾기 (없으면 루트)
  const parentNode = referenceNode.parentId ? tree.nodeMap.get(referenceNode.parentId) : tree.root;

  if (!parentNode || !Array.isArray((parentNode as any).children)) {
    console.warn('부모 노드가 유효하지 않음, 문서 끝에 추가합니다.');
    appendSectionToEnd(tree, headingNode, bodyNodes);
    return;
  }

  const parentChildren = (parentNode as any).children;
  const referenceIndex = parentChildren.findIndex((child: any) => child.id === referenceNodeId);

  if (referenceIndex === -1) {
    console.warn('참조 노드를 부모의 children에서 찾을 수 없음, 문서 끝에 추가합니다.');
    appendSectionToEnd(tree, headingNode, bodyNodes);
    return;
  }

  // 참조 노드 뒤에 헤딩과 본문 노드들 삽입
  parentChildren.splice(referenceIndex + 1, 0, headingNode, ...bodyNodes);

  // 부모 노드 업데이트
  if (referenceNode.parentId) {
    tree.nodeMap.set(referenceNode.parentId, parentNode);
  }

  console.log(`섹션이 노드 ${referenceNodeId} 뒤에 삽입되었습니다.`);
}

/**
 * 문서 끝에 섹션 추가
 */
function appendSectionToEnd(tree: DocumentTree, headingNode: ExtendedNode, bodyNodes: ExtendedNode[]): void {
  // 루트 레벨에 섹션 추가
  if (Array.isArray(tree.root.children)) {
    // 헤딩 노드 추가
    tree.root.children.push(headingNode as any);

    // 본문 노드들 추가
    for (const bodyNode of bodyNodes) {
      tree.root.children.push(bodyNode as any);
    }

    console.log(`섹션이 문서 끝에 추가되었습니다: 헤딩 + ${bodyNodes.length}개 본문 노드`);
  } else {
    // children 배열 초기화하고 모든 노드 추가
    tree.root.children = [headingNode as any, ...(bodyNodes as any[])];
    console.log(`루트 children 배열을 초기화하고 섹션을 추가했습니다: 헤딩 + ${bodyNodes.length}개 본문 노드`);
  }

  // 디버깅: children 배열의 실제 내용 확인
  console.log(`트리의 children 개수: ${tree.root.children?.length || 0}`);
  if (tree.root.children && tree.root.children.length > 0) {
    const lastFewNodes = tree.root.children.slice(-3).map((node: any) => ({
      type: node.type,
      id: node.id,
      hasChildren: !!node.children,
    }));
    console.log('마지막 3개 노드:', lastFewNodes);
  }
}

/**
 * LLM이 생성한 content를 파싱하여 개별 listItem/paragraph로 분할
 * 사용자 친화적으로 단일 줄바꿈도 별개 paragraph로 분리하고,
 * 리스트와 paragraph가 섞인 복잡한 케이스도 처리
 * @param content LLM이 생성한 마크다운 content
 * @returns 분할된 content 항목들의 배열
 */
export function parseAndSplitContent(
  content: string,
): Array<{ type: 'listItem' | 'paragraph' | 'list'; content: string }> {
  const result: Array<{ type: 'listItem' | 'paragraph' | 'list'; content: string }> = [];

  if (!content || !content.trim()) {
    return result;
  }

  try {
    // 먼저 이중 줄바꿈으로 블록 단위 분리 (마크다운의 기본 paragraph 분리)
    const blocks = content.split(/\n\s*\n/).filter((block) => block.trim());

    if (blocks.length > 1) {
      // 이중 줄바꿈으로 분리된 블록들이 있는 경우, 각 블록을 개별 처리
      for (const block of blocks) {
        result.push(...parseBlock(block.trim()));
      }
    } else {
      // 이중 줄바꿈이 없는 경우, 전체를 하나의 블록으로 처리
      result.push(...parseBlock(content.trim()));
    }
  } catch (error) {
    console.warn('Content 파싱 실패, 원본을 paragraph로 처리:', error);
    // 파싱 실패 시 원본 content를 paragraph로 처리
    result.push({
      type: 'paragraph',
      content: content.trim(),
    });
  }

  return result;
}

/**
 * 단일 블록을 파싱하여 리스트와 paragraph를 분리
 * 마크다운 구조를 유지하며 블록 단위로 처리
 */
function parseBlock(block: string): Array<{ type: 'listItem' | 'paragraph' | 'list'; content: string }> {
  const result: Array<{ type: 'listItem' | 'paragraph' | 'list'; content: string }> = [];

  // 줄 단위로 분리
  const lines = block.split('\n');

  let currentSection: string[] = [];
  let currentSectionType: 'list' | 'paragraph' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      // 빈 줄인 경우 현재 섹션을 처리하고 초기화
      if (currentSection.length > 0) {
        flushCurrentSection();
      }
      continue;
    }

    const isListLine = isListItemLine(line);

    if (isListLine) {
      // 리스트 라인인 경우
      if (currentSectionType !== 'list') {
        // 이전 섹션이 있다면 먼저 처리
        if (currentSection.length > 0) {
          flushCurrentSection();
        }
        currentSectionType = 'list';
      }
      currentSection.push(line);
    } else {
      // 일반 텍스트 라인인 경우
      if (currentSectionType !== 'paragraph') {
        // 이전 섹션이 있다면 먼저 처리
        if (currentSection.length > 0) {
          flushCurrentSection();
        }
        currentSectionType = 'paragraph';
      }
      currentSection.push(line);
    }
  }

  // 마지막 섹션 처리
  if (currentSection.length > 0) {
    flushCurrentSection();
  }

  function flushCurrentSection() {
    if (currentSectionType === 'list') {
      // 연속된 리스트 항목들을 하나의 list로 그룹핑
      const listContent = currentSection.join('\n');
      result.push({
        type: 'list',
        content: listContent,
      });
    } else if (currentSectionType === 'paragraph') {
      // paragraph 내용을 하나로 합치기
      const paragraphContent = currentSection.join(' ').trim();
      if (paragraphContent) {
        result.push({
          type: 'paragraph',
          content: paragraphContent,
        });
      }
    }

    // 섹션 초기화
    currentSection = [];
    currentSectionType = null;
  }

  return result;
}

/**
 * 라인이 리스트 아이템인지 확인
 */
function isListItemLine(line: string): boolean {
  // 마크다운 리스트 패턴: -, *, +, 또는 숫자.
  return /^(\s*[-*+]|\s*\d+\.)\s/.test(line);
}

/**
 * content items를 기존 노드의 속성을 상속받는 새 노드들로 변환
 * @param originalNode 기존 노드 (속성 상속용)
 * @param contentItems 변환할 content items
 * @returns 생성된 새 노드들
 */
export function createReplacementNodes(
  originalNode: ExtendedNode,
  contentItems: Array<{ type: 'listItem' | 'paragraph' | 'list'; content: string }>,
): ExtendedNode[] {
  const timestamp = Date.now();
  const replacementNodes: ExtendedNode[] = [];

  for (const [index, item] of contentItems.entries()) {
    const newNodeId = `${originalNode.id}_replacement_${timestamp}_${index}`;

    let newNode: ExtendedNode;

    if (item.type === 'paragraph') {
      newNode = {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            value: item.content,
          },
        ],
        id: newNodeId,
        fileName: originalNode.fileName,
        parentId: originalNode.parentId,
        sectionId: originalNode.sectionId,
      } as Paragraph & ExtendedNode;
    } else if (item.type === 'listItem') {
      newNode = {
        type: 'listItem',
        children: [
          {
            type: 'paragraph',
            children: [
              {
                type: 'text',
                value: item.content,
              },
            ],
          },
        ],
        id: newNodeId,
        fileName: originalNode.fileName,
        parentId: originalNode.parentId,
        sectionId: originalNode.sectionId,
        isListItem: true,
        listItemIndex: index,
      } as ListItem & ExtendedNode;
    } else if (item.type === 'list') {
      // list 타입의 경우 마크다운 파싱해서 list 노드 생성
      try {
        const processor = unified().use(remarkParse);

        const parsedMarkdown = processor.parse(item.content) as Root;

        if (parsedMarkdown.children && parsedMarkdown.children.length > 0) {
          const listNode = parsedMarkdown.children[0] as any;
          if (listNode && listNode.type === 'list') {
            // list 노드의 children들을 처리해서 ExtendedNode로 변환
            const listChildren = listNode.children.map((child: any, childIndex: number) => {
              const childNodeId = `${newNodeId}_item_${childIndex}`;
              return {
                ...child,
                id: childNodeId,
                fileName: originalNode.fileName,
                parentId: newNodeId,
                sectionId: originalNode.sectionId,
                isListItem: true,
                listItemIndex: childIndex,
              };
            });

            newNode = {
              type: 'list',
              ordered: listNode.ordered || false,
              spread: listNode.spread || false,
              children: listChildren,
              id: newNodeId,
              fileName: originalNode.fileName,
              parentId: originalNode.parentId,
              sectionId: originalNode.sectionId,
            } as List & ExtendedNode;
          } else {
            // list가 아닌 경우 paragraph로 처리
            newNode = {
              type: 'paragraph',
              children: [
                {
                  type: 'text',
                  value: item.content,
                },
              ],
              id: newNodeId,
              fileName: originalNode.fileName,
              parentId: originalNode.parentId,
              sectionId: originalNode.sectionId,
            } as Paragraph & ExtendedNode;
          }
        } else {
          continue; // 빈 내용은 건너뛰기
        }
      } catch (error) {
        console.warn('List 파싱 실패, paragraph로 처리:', error);
        newNode = {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: item.content,
            },
          ],
          id: newNodeId,
          fileName: originalNode.fileName,
          parentId: originalNode.parentId,
          sectionId: originalNode.sectionId,
        } as Paragraph & ExtendedNode;
      }
    } else {
      continue; // 지원하지 않는 타입은 건너뛰기
    }

    replacementNodes.push(newNode);
    console.log(`[DEBUG] createReplacementNodes: Created ${item.type} node ${newNodeId}`);
  }

  console.log(`[DEBUG] createReplacementNodes: Created ${replacementNodes.length} replacement nodes`);
  return replacementNodes;
}

/**
 * 기존 노드를 새로운 노드들로 원자적으로 교체합니다 (tree 구조 안정성 확보)
 * @param tree 문서 트리
 * @param nodeId 교체할 기존 노드 ID
 * @param replacementNodes 교체할 새 노드들
 * @returns 업데이트된 문서 트리
 */
export function replaceNodeAtomically(
  tree: DocumentTree,
  nodeId: string,
  replacementNodes: ExtendedNode[],
): DocumentTree {
  const nodeToReplace = tree.nodeMap.get(nodeId);
  if (!nodeToReplace) {
    console.warn(`Node ${nodeId} not found in tree for atomic replacement`);
    return tree;
  }

  console.log(`[DEBUG] replaceNodeAtomically: Replacing node ${nodeId} with ${replacementNodes.length} new nodes`);
  console.log(`[DEBUG] replaceNodeAtomically: Original nodeMap size: ${tree.nodeMap.size}`);

  // 원본 트리의 깊은 복사본 생성
  const newTree: DocumentTree = {
    title: tree.title,
    nodeMap: new Map(tree.nodeMap),
    sectionMap: new Map(tree.sectionMap),
    root: JSON.parse(JSON.stringify(tree.root)),
  };

  console.log(`[DEBUG] replaceNodeAtomically: Copied nodeMap size: ${newTree.nodeMap.size}`);

  // Helper function to recursively add nodes and their children to nodeMap
  const addNodeToMapRecursively = (node: ExtendedNode): void => {
    if (node.id) {
      newTree.nodeMap.set(node.id, node);
      console.log(`[DEBUG] replaceNodeAtomically: Added node ${node.id} to nodeMap`);

      // Recursively add children if they exist (type check for nodes that can have children)
      const nodeWithChildren = node as any;
      if (nodeWithChildren.children && Array.isArray(nodeWithChildren.children)) {
        for (const child of nodeWithChildren.children) {
          if (child.id) {
            addNodeToMapRecursively(child);
          }
        }
      }
    }
  };

  // 1. 새 노드들을 nodeMap에 추가 (재귀적으로 자식 노드들도 포함)
  console.log(`[DEBUG] replaceNodeAtomically: Adding ${replacementNodes.length} nodes to nodeMap`);
  for (const [index, node] of replacementNodes.entries()) {
    if (node.id) {
      addNodeToMapRecursively(node);
      console.log(`[DEBUG] replaceNodeAtomically: Processed node ${node.id} (${index + 1}/${replacementNodes.length})`);
    } else {
      console.warn(`[DEBUG] replaceNodeAtomically: Node at index ${index} has no ID`);
    }
  }

  // 2. 기존 노드를 nodeMap에서 제거
  const wasDeleted = newTree.nodeMap.delete(nodeId);
  console.log(`[DEBUG] replaceNodeAtomically: Deleted original node ${nodeId}: ${wasDeleted}`);

  // 3. 부모 노드에서 기존 노드를 새 노드들로 교체
  if (nodeToReplace.parentId) {
    const parentNode = newTree.nodeMap.get(nodeToReplace.parentId);
    if (parentNode && Array.isArray((parentNode as any).children)) {
      const parentChildren = (parentNode as any).children;
      const nodeIndex = parentChildren.findIndex((child: any) => child.id === nodeId);

      if (nodeIndex !== -1) {
        // 기존 노드를 새 노드들로 교체 (splice 사용)
        parentChildren.splice(nodeIndex, 1, ...replacementNodes);
        console.log(
          `[DEBUG] replaceNodeAtomically: Replaced node ${nodeId} at index ${nodeIndex} in parent ${nodeToReplace.parentId}`,
        );

        // 부모 노드 업데이트
        newTree.nodeMap.set(nodeToReplace.parentId, parentNode);
        updateNodeInRootTree(newTree, parentNode);
      }
    }
  } else {
    // 루트 레벨에서 교체
    if (Array.isArray(newTree.root.children)) {
      const rootChildren = newTree.root.children as any[];
      const nodeIndex = rootChildren.findIndex((child: any) => child.id === nodeId);

      if (nodeIndex !== -1) {
        rootChildren.splice(nodeIndex, 1, ...replacementNodes);
        console.log(`[DEBUG] replaceNodeAtomically: Replaced node ${nodeId} at index ${nodeIndex} in root`);
      }
    }
  }

  console.log(`[DEBUG] replaceNodeAtomically: Final nodeMap size: ${newTree.nodeMap.size}`);
  console.log(`[DEBUG] replaceNodeAtomically: Final nodeMap keys: ${Array.from(newTree.nodeMap.keys()).join(', ')}`);
  console.log(
    `[DEBUG] replaceNodeAtomically: Successfully replaced node ${nodeId} with ${replacementNodes.length} replacement nodes`,
  );
  return newTree;
}
