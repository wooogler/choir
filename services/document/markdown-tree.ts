import type { Heading, List, ListItem, Paragraph, Root, Text } from 'mdast';
import { toString as nodeToText } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { Node, Parent } from 'unist';
import { is } from 'unist-util-is';
import { visit } from 'unist-util-visit';
import { v4 as uuidv4 } from 'uuid';
import type { DocumentTree, ExtendedNode } from './document-types';

export type { DocumentTree, ExtendedNode } from './document-types';

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

  // Images MUST be preserved: without this case an image node (no value, no
  // children) flattens to '' and is silently deleted from the committed file.
  if (node.type === 'image') {
    const title = node.title ? ` "${node.title}"` : '';
    return `![${node.alt || ''}](${node.url || ''}${title})`;
  }

  if (node.type === 'imageReference') {
    return `![${node.alt || ''}][${node.label || node.identifier || ''}]`;
  }

  if (node.type === 'linkReference') {
    const text = node.children ? node.children.map((child: any) => nodeToMarkdown(child)).join('') : '';
    return `[${text}][${node.label || node.identifier || ''}]`;
  }

  if (node.type === 'delete') {
    const text = node.children ? node.children.map((child: any) => nodeToMarkdown(child)).join('') : '';
    return `~~${text}~~`;
  }

  if (node.type === 'break') {
    return '\n';
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

  // 빈 헤딩 다음에 빈 paragraph 자동 추가 + 완전히 빈 파일에 빈 paragraph 추가
  if (root.children && Array.isArray(root.children)) {
    // 완전히 빈 파일인 경우 (자식 노드가 없거나 모두 빈 텍스트인 경우)
    const hasContent = root.children.some((child) => {
      if (is(child, 'paragraph')) {
        const textContent = nodeToText(child).trim();
        return textContent.length > 0;
      }
      return is(child, 'heading') || is(child, 'list') || is(child, 'code') || is(child, 'blockquote');
    });

    if (!hasContent && root.children.length === 0) {
      // 완전히 빈 파일에 빈 paragraph 노드 추가
      const emptyParagraph: Paragraph = {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            value: '', // 빈 문자열
          } as Text,
        ],
      };
      root.children = [emptyParagraph];
      console.log('완전히 빈 파일에 빈 paragraph 추가');
    } else {
      // 기존 로직: 빈 헤딩 다음에 빈 paragraph 추가
      const newChildren: any[] = [];

      for (let i = 0; i < root.children.length; i++) {
        const currentNode = root.children[i];
        newChildren.push(currentNode);

        // 현재 노드가 헤딩인 경우
        if (is(currentNode, 'heading')) {
          const nextNode = i + 1 < root.children.length ? root.children[i + 1] : null;

          // 다음 노드가 없거나, 다음 노드도 헤딩인 경우 (즉, 현재 헤딩 다음에 콘텐츠가 없음)
          if (!nextNode || is(nextNode, 'heading')) {
            // 빈 paragraph 노드 추가
            const emptyParagraph: Paragraph = {
              type: 'paragraph',
              children: [
                {
                  type: 'text',
                  value: '', // 빈 문자열
                } as Text,
              ],
            };
            newChildren.push(emptyParagraph);
            console.log(`빈 헤딩 "${(currentNode as any).children?.[0]?.value || 'unknown'}" 다음에 빈 paragraph 추가`);
          }
        }
      }

      root.children = newChildren;
    }
  }

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

      case 'heading': {
        const headingLevel = '#'.repeat(node.depth || 1);
        const headingText = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';
        return `${headingLevel} ${headingText}`;
      }

      case 'paragraph': {
        const paragraphText = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';
        return paragraphText;
      }

      case 'list': {
        const listItems = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n')
          : '';
        return listItems;
      }

      case 'listItem': {
        const bullet = node.ordered ? '1.' : '-';
        const itemContent = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';

        // If itemContent already starts with a list marker, use it as is
        if (itemContent.match(/^-\s+/)) {
          return `${indent}${itemContent}`;
        }

        return `${indent}${bullet} ${itemContent}`;
      }

      case 'blockquote': {
        const quoteContent = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('\n')
          : '';
        return quoteContent
          .split('\n')
          .map((line: string) => `> ${line}`)
          .join('\n');
      }

      case 'code': {
        const language = node.lang || '';
        const codeContent = node.value || '';
        return `\`\`\`${language}\n${codeContent}\n\`\`\``;
      }

      case 'text':
        return node.value || '';

      case 'strong': {
        const strongText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        return `**${strongText}**`;
      }

      case 'emphasis': {
        const emphasisText = node.children
          ? node.children.map((child: any) => astToMarkdown(child, depth)).join('')
          : '';
        return `*${emphasisText}*`;
      }

      case 'inlineCode':
        return `\`${node.value || ''}\``;

      case 'link': {
        const linkText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        const linkUrl = node.url || '';
        return `[${linkText}](${linkUrl})`;
      }

      case 'image': {
        const imageTitle = node.title ? ` "${node.title}"` : '';
        return `![${node.alt || ''}](${node.url || ''}${imageTitle})`;
      }

      case 'imageReference':
        return `![${node.alt || ''}][${node.label || node.identifier || ''}]`;

      case 'linkReference': {
        const refText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        return `[${refText}][${node.label || node.identifier || ''}]`;
      }

      case 'definition': {
        const defTitle = node.title ? ` "${node.title}"` : '';
        return `[${node.label || node.identifier || ''}]: ${node.url || ''}${defTitle}`;
      }

      case 'delete': {
        const deleteText = node.children ? node.children.map((child: any) => astToMarkdown(child, depth)).join('') : '';
        return `~~${deleteText}~~`;
      }

      case 'break':
        return '\n';

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

  for (const node of docTree.nodeMap.values()) {
    if (node.sectionId === sectionId) {
      result.push(node);
    }
  }

  return result;
}
