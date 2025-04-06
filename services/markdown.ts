import { marked, Renderer } from "marked";
import type { Tokens as MarkedTokens } from "marked";

export interface MarkdownNode {
  type: string;
  depth?: number;
  text?: string;
  children: MarkdownNode[];
  sectionIndex?: string;
  contentIndex?: string;
}

export interface MarkdownTree {
  title: string;
  content: MarkdownNode[];
}

export function parseMarkdownToTree(markdown: string): MarkdownTree {
  const tokens = marked.lexer(markdown);
  const tree: MarkdownTree = {
    title: "",
    content: [],
  };

  let currentSection: MarkdownNode | null = null;
  const sectionStack: MarkdownNode[] = [];
  let sectionCount = 0;

  for (const token of tokens) {
    if (token.type === "heading") {
      const headingToken = token as MarkedTokens.Heading;

      if (headingToken.depth === 1) {
        tree.title = headingToken.text;
        continue;
      }

      sectionCount++;
      const currentSectionIndex = String(sectionCount);

      const newSection: MarkdownNode = {
        type: "section",
        depth: headingToken.depth - 1,
        text: headingToken.raw.trim(),
        children: [],
        sectionIndex: currentSectionIndex,
      };

      while (
        sectionStack.length > 0 &&
        (sectionStack[sectionStack.length - 1].depth ?? 0) >=
          (newSection.depth ?? 0)
      ) {
        sectionStack.pop();
      }

      if (sectionStack.length === 0) {
        tree.content.push(newSection);
      } else {
        sectionStack[sectionStack.length - 1].children.push(newSection);
      }

      sectionStack.push(newSection);
      currentSection = newSection;

      let contentCount = 0;
      const parentSectionIndex =
        sectionStack.length > 0
          ? sectionStack[sectionStack.length - 1].sectionIndex
          : currentSectionIndex;

      const addIndexToNode = (node: MarkdownNode) => {
        contentCount++;
        node.sectionIndex = parentSectionIndex;
        node.contentIndex = String(contentCount);
      };

      const originalPush = newSection.children.push;
      newSection.children.push = function (...items: MarkdownNode[]) {
        items.forEach(addIndexToNode);
        return originalPush.apply(this, items);
      };
    } else if (currentSection) {
      if (token.type === "list") {
        const listToken = token as MarkedTokens.List;
        const listNode: MarkdownNode = {
          type: "list",
          text: token.raw.trim(),
          children: [],
          sectionIndex: currentSection.sectionIndex,
        };
        currentSection.children.push(listNode);

        listNode.children = listToken.items.map((item, idx) => ({
          type: "list-item",
          text: item.raw.trim(),
          children: [],
          sectionIndex: currentSection?.sectionIndex,
          contentIndex: `${listNode.contentIndex}-${idx + 1}`,
        }));
      } else {
        const contentNode: MarkdownNode = {
          type: token.type,
          text: token.raw.trim(),
          children: [],
          sectionIndex: currentSection.sectionIndex,
        };
        currentSection.children.push(contentNode);
      }
    }
  }

  return tree;
}

export function treeToMarkdown(tree: MarkdownTree): string {
  let markdown = "";

  if (tree.title) {
    markdown += `# ${tree.title}\n\n`;
  }

  function renderNode(node: MarkdownNode): string {
    let result = "";

    if (node.type === "section") {
      result += `${node.text}\n\n`;

      for (const child of node.children) {
        result += renderNode(child);
      }
    } else if (node.type === "list" || node.type === "paragraph") {
      result += `${node.text}\n\n`;
    }

    return result;
  }

  for (const node of tree.content) {
    markdown += renderNode(node);
  }

  return markdown.trim();
}

export async function convertMarkdownToSlackText(
  markdown: string
): Promise<string> {
  const renderer = new Renderer();

  // 수평선은 divider로 변환
  renderer.hr = () => {
    return "---\n";
  };

  // 헤딩은 Slack에서 굵은 텍스트 처리
  renderer.heading = ({ text }: MarkedTokens.Heading) => {
    return `*${text}*\n\n`;
  };

  // 링크는 링크 텍스트만 표시 (URL 제거)
  renderer.link = ({ text }: MarkedTokens.Link) => {
    return text;
  };

  // italic', 'bold' 등은 Slack에서 Marked가 자동 변환하는 걸 믿고, 필요 시 추가 처리 가능
  // HTML은 제거
  renderer.html = () => {
    return "";
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

  let slackText = await marked.parse(markdown, {
    renderer,
    gfm: true,
  });

  // 수평선 마커를 실제 divider 블록으로 변환
  slackText = slackText.replace(/___DIVIDER___/g, '{"type":"divider"}');

  return slackText.trim();
}
