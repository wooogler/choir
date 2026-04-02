export interface UpdateAnchor {
  source: 'qmd';
  anchorId: string;
  filePath: string;
  snippet: string;
  originalText: string;
  title?: string;
  score?: number;
  startLine?: number;
  endLine?: number;
  focusLine?: number;
  snippetLines?: number;
  chunkPos?: number;
}

export interface AnchorApplyResult {
  success: boolean;
  updatedMarkdown: string;
  replacementCount: number;
}

export function stripSnippetHeader(snippet: string): string {
  const [firstLine, ...restLines] = snippet.split('\n');
  if (firstLine?.startsWith('@@ ')) {
    return restLines.join('\n').trim();
  }

  return snippet.trim();
}

function getLineStartOffsets(markdown: string): number[] {
  const offsets = [0];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === '\n') {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

function getCharOffsetForLine(markdown: string, lineNumber?: number): number | null {
  if (!lineNumber || lineNumber < 1) {
    return null;
  }

  const offsets = getLineStartOffsets(markdown);
  return offsets[lineNumber - 1] ?? null;
}

function findAllOccurrences(markdown: string, target: string): number[] {
  if (!target) {
    return [];
  }

  const matches: number[] = [];
  let searchIndex = 0;

  while (searchIndex < markdown.length) {
    const matchIndex = markdown.indexOf(target, searchIndex);
    if (matchIndex === -1) {
      break;
    }

    matches.push(matchIndex);
    searchIndex = matchIndex + Math.max(1, target.length);
  }

  return matches;
}

export function applyAnchorReplacement(markdown: string, anchor: UpdateAnchor, replacement: string): AnchorApplyResult {
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n');
  const targetText = anchor.originalText.replace(/\r\n/g, '\n').trim();

  if (!targetText) {
    return {
      success: false,
      updatedMarkdown: markdown,
      replacementCount: 0,
    };
  }

  const matches = findAllOccurrences(normalizedMarkdown, targetText);
  if (matches.length === 0) {
    return {
      success: false,
      updatedMarkdown: markdown,
      replacementCount: 0,
    };
  }

  let selectedMatch = matches[0];
  if (matches.length > 1) {
    const expectedOffset = getCharOffsetForLine(normalizedMarkdown, anchor.startLine);
    if (expectedOffset !== null) {
      selectedMatch = matches.reduce((best, current) =>
        Math.abs(current - expectedOffset) < Math.abs(best - expectedOffset) ? current : best,
      );
    }
  }

  const updatedMarkdown =
    normalizedMarkdown.slice(0, selectedMatch) + replacement.trim() + normalizedMarkdown.slice(selectedMatch + targetText.length);

  return {
    success: true,
    updatedMarkdown,
    replacementCount: 1,
  };
}
