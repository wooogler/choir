import { diffArrays } from "diff";

interface RichTextElement {
  type: "text" | "rich_text_section" | "divider";
  text?: string;
  style?: Record<string, boolean>;
  elements?: RichTextElement[];
}

// (1) 토큰화 (URL vs 공백 vs 기타) - 동일
function tokenize(str: string): string[] {
  const tokens: string[] = [];
  const regex = /(https?:\/\/[^\s]+|www\.[^\s]+|\s+|[^\s]+)/g;

  for (const match of str.matchAll(regex)) {
    tokens.push(match[0]);
  }
  return tokens;
}

// (2) 한 줄 인라인 볼드 파서
function parseInlineBold(
  line: string,
  baseStyle: Record<string, boolean>
): RichTextElement[] {
  // `*...*` 구간을 찾아내어 그 부분만 bold를 적용
  const regex = /\*(.+?)\*/g;
  const elements: RichTextElement[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while (true) {
    match = regex.exec(line);
    if (match === null) break;

    const matchIndex = match.index ?? 0;

    // 앞부분 (볼드 아님)
    if (matchIndex > lastIndex) {
      const segment = line.slice(lastIndex, matchIndex);
      elements.push({
        type: "text",
        text: segment,
        style: { ...baseStyle },
      });
    }

    // `*...*` 부분 (볼드)
    const boldText = match[1];
    elements.push({
      type: "text",
      text: boldText,
      style: { ...baseStyle, bold: true },
    });

    lastIndex = regex.lastIndex;
  }

  // 마지막 남은 부분
  if (lastIndex < line.length) {
    const segment = line.slice(lastIndex);
    elements.push({
      type: "text",
      text: segment,
      style: { ...baseStyle },
    });
  }

  return elements;
}

/**
 * (3) createDiffBlock
 *   - old/new 텍스트를 토큰화 후 diff
 *   - removed => strike, added => bold
 *   - 한 덩어리를 "단일 라인"으로 처리 (줄바꿈/불릿 없음)
 */
export function createDiffBlock(oldText: string, newText: string) {
  // 1) 토큰화
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);

  // 2) diff
  const diffs = diffArrays(oldTokens, newTokens);

  // 3) 모든 diff chunk를 section들로 연결
  const elements: RichTextElement[] = [];

  for (const diff of diffs) {
    const textValue = diff.value.join("");

    // "---" 또는 "___DIVIDER___"를 divider 블록으로 변환
    if (textValue.trim() === "---") {
      elements.push({ type: "divider" });
      continue;
    }

    // baseStyle (removed => strike, added => bold)
    const baseStyle: Record<string, boolean> = {};
    if (diff.added) {
      baseStyle.bold = true;
    }
    if (diff.removed) {
      baseStyle.strike = true;
    }

    const inlineElements = parseInlineBold(textValue, baseStyle);
    elements.push(...inlineElements);
  }

  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements,
      },
    ],
  };
}
