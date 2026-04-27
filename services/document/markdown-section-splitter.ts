export interface MarkdownItem {
  index: number;
  heading: string;
  content: string;
}

/**
 * Splits markdown into one item-level file per listItem / paragraph / code block,
 * mirroring the old FAISS Document granularity.
 *
 * Each item file contains a `# Heading` context line followed by the item content,
 * so QMD can extract a meaningful title and embed the full context.
 */
export function splitMarkdownToItems(markdown: string, fileBaseName: string): MarkdownItem[] {
  const items: MarkdownItem[] = [];
  const headingStack: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  const currentHeading = () => {
    for (let i = headingStack.length - 1; i >= 0; i -= 1) {
      if (headingStack[i]) return headingStack[i];
    }
    return fileBaseName;
  };

  const pushItem = (heading: string, rawContent: string) => {
    const content = rawContent.trim();
    if (!content) return;
    items.push({
      index: items.length,
      heading,
      content: `# ${heading}\n\n${content}`,
    });
  };

  let paragraph: string[] = [];
  let codeBlock: string[] = [];
  let insideCodeFence = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    pushItem(currentHeading(), paragraph.join('\n'));
    paragraph = [];
  };

  const flushCodeBlock = () => {
    if (codeBlock.length === 0) return;
    pushItem(currentHeading(), codeBlock.join('\n'));
    codeBlock = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    const fenceMatch = line.trim().startsWith('```');
    const listItemMatch = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);

    if (insideCodeFence) {
      codeBlock.push(line);
      if (fenceMatch) {
        insideCodeFence = false;
        flushCodeBlock();
      }
      continue;
    }

    if (fenceMatch) {
      flushParagraph();
      insideCodeFence = true;
      codeBlock.push(line);
      continue;
    }

    if (headingMatch) {
      flushParagraph();
      const depth = headingMatch[1].length;
      headingStack.length = depth;
      headingStack[depth - 1] = headingMatch[2].trim();
      continue;
    }

    if (listItemMatch) {
      flushParagraph();
      pushItem(currentHeading(), line.trim());
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  if (insideCodeFence) {
    flushCodeBlock();
  }
  flushParagraph();

  if (items.length === 0) {
    return [{ index: 0, heading: fileBaseName, content: markdown.trim() }];
  }

  return items;
}

/**
 * Strips the `# Heading\n\n` context prefix that splitMarkdownToItems adds,
 * returning just the raw item content that exists in the original file.
 */
export function stripItemHeadingPrefix(sectionBody: string): string {
  const match = sectionBody.match(/^#[^\n]*\n\n?/);
  return match ? sectionBody.slice(match[0].length) : sectionBody;
}

/**
 * Converts a section-relative path back to the original file's relative path.
 * e.g. "policies/0.md"                → "policies.md"
 *      "docs/guide/3.md"              → "docs/guide.md"
 */
export function sectionPathToOriginalPath(sectionRelativePath: string): string {
  const normalized = sectionRelativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 1) return normalized;
  return parts.slice(0, -1).join('/') + '.md';
}
