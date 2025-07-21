/**
 * Slack 메시지의 text 필드를 blocks 내용과 일치시키기 위한 유틸리티
 * conversation history에서 사용되므로 AI가 충분한 맥락을 이해할 수 있도록 함
 */

interface MessageButton {
  text: string;
  style?: 'primary' | 'danger';
  url?: string;
}

interface MessageOptions {
  buttons?: MessageButton[];
  links?: Array<{ url: string; text: string }>;
  diffSummary?: string;
  metadata?: Record<string, any>;
}

/**
 * 이모지 코드를 실제 유니코드 이모지로 변환
 */
const EMOJI_MAP: Record<string, string> = {
  mag: '🔍',
  brain: '🧠',
  thinking_face: '🤔',
  memo: '📝',
  gear: '⚙️',
  check: '✅',
  x: '❌',
  warning: '⚠️',
  tada: '🎉',
  sparkles: '✨',
  file_folder: '📁',
  page_facing_up: '📄',
  chart_with_upwards_trend: '📊',
  link: '🔗',
  bell: '🔔',
  lock: '🔒',
  key: '🔑',
  rocket: '🚀',
  bulb: '💡',
  fire: '🔥',
  heart: '❤️',
  thumbsup: '👍',
  thumbsdown: '👎',
  eyes: '👀',
};

/**
 * 마크다운을 일반 텍스트로 변환
 */
function convertMarkdownToText(markdown: string): string {
  return (
    markdown
      // *bold* → bold
      .replace(/\*([^*]+)\*/g, '$1')
      // **bold** → bold
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      // _italic_ → italic
      .replace(/_([^_]+)_/g, '$1')
      // `code` → code
      .replace(/`([^`]+)`/g, '$1')
      // ```code block``` → code block
      .replace(/```[\s\S]*?```/g, (match) => {
        const lines = match.replace(/```/g, '').trim().split('\n');
        return lines.length > 3 ? `${lines[0]}... (${lines.length} lines)` : lines.join(' ');
      })
      // <url|text> → text (url)
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)')
      // <url> → url
      .replace(/<([^>]+)>/g, '$1')
      // Remove multiple spaces
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * 이모지 코드를 실제 이모지로 변환
 */
function convertEmojis(text: string): string {
  return text.replace(/:(\w+):/g, (match, emojiName) => {
    return EMOJI_MAP[emojiName] || match;
  });
}

/**
 * 버튼 정보를 텍스트로 변환
 */
function formatButtons(buttons: MessageButton[]): string {
  if (!buttons || buttons.length === 0) return '';

  const buttonTexts = buttons.map((button) => {
    let buttonText = `[${button.text}]`;
    if (button.style === 'primary') buttonText = `**${buttonText}`;
    if (button.style === 'danger') buttonText = `⚠️${buttonText}`;
    if (button.url) buttonText += ` (${button.url})`;
    return buttonText;
  });

  return ` ${buttonTexts.join(' ')}`;
}

/**
 * 링크 정보를 텍스트로 변환
 */
function formatLinks(links: Array<{ url: string; text: string }>): string {
  if (!links || links.length === 0) return '';

  return links.map((link) => `${link.text} (${link.url})`).join(', ');
}

/**
 * Slack rich text 요소에서 텍스트 추출
 */
function extractTextFromRichTextElement(element: any): { text: string; type: 'added' | 'removed' | 'unchanged' } {
  if (!element) return { text: '', type: 'unchanged' };

  let text = '';
  let type: 'added' | 'removed' | 'unchanged' = 'unchanged';

  if (element.text) {
    text = element.text;

    // 스타일링으로 타입 판단
    if (element.style) {
      if (element.style.bold) type = 'added';
      if (element.style.strike) type = 'removed';
    }
  }

  return { text, type };
}

/**
 * Slack rich text diff 블록에서 변경사항 추출
 */
function extractChangesFromRichTextDiff(diffBlock: any): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];

  if (!diffBlock || !diffBlock.elements) return { added, removed };

  // rich_text_quote 요소들을 순회
  for (const element of diffBlock.elements) {
    if (element.type === 'rich_text_quote' && element.elements) {
      for (const textElement of element.elements) {
        const { text, type } = extractTextFromRichTextElement(textElement);

        if (text.trim()) {
          if (type === 'added') {
            added.push(text.trim());
          } else if (type === 'removed') {
            removed.push(text.trim());
          }
        }
      }
    }
  }

  return { added, removed };
}

/**
 * diff 요약을 텍스트로 변환 - 실제 변경 내용 표시
 */
function formatDiffSummary(diffContent: any): string {
  if (!diffContent) return '';

  // Slack rich text diff 블록인 경우
  if (typeof diffContent === 'object' && diffContent.type === 'rich_text') {
    const { added, removed } = extractChangesFromRichTextDiff(diffContent);

    if (added.length === 0 && removed.length === 0) return '';

    const summary = ' - Changes: ';
    const changes = [];

    // 제거된 내용
    if (removed.length > 0) {
      const removedContent = removed.join('; ');
      const truncatedRemoved = removedContent.length > 150 ? removedContent.substring(0, 150) + '...' : removedContent;
      changes.push(`Removed: "${truncatedRemoved}"`);
    }

    // 추가된 내용
    if (added.length > 0) {
      const addedContent = added.join('; ');
      const truncatedAdded = addedContent.length > 150 ? addedContent.substring(0, 150) + '...' : addedContent;
      changes.push(`Added: "${truncatedAdded}"`);
    }

    return summary + changes.join(' | ');
  }

  // 기존 문자열 diff 형식인 경우 (fallback)
  if (typeof diffContent === 'string') {
    const lines = diffContent.split('\n');

    const addedLines = lines
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.substring(1).trim())
      .filter((line) => line.length > 0);

    const removedLines = lines
      .filter((line) => line.startsWith('-') && !line.startsWith('---'))
      .map((line) => line.substring(1).trim())
      .filter((line) => line.length > 0);

    if (addedLines.length === 0 && removedLines.length === 0) return '';

    const summary = ' - Changes: ';
    const changes = [];

    if (removedLines.length > 0) {
      const removedContent = removedLines.join('; ');
      const truncatedRemoved = removedContent.length > 150 ? removedContent.substring(0, 150) + '...' : removedContent;
      changes.push(`Removed: "${truncatedRemoved}"`);
    }

    if (addedLines.length > 0) {
      const addedContent = addedLines.join('; ');
      const truncatedAdded = addedContent.length > 150 ? addedContent.substring(0, 150) + '...' : addedContent;
      changes.push(`Added: "${truncatedAdded}"`);
    }

    return summary + changes.join(' | ');
  }

  return '';
}

/**
 * blocks 내용을 분석하여 포괄적인 text 생성
 */
export function createComprehensiveText(baseText: string, blocks: any[], options: MessageOptions = {}): string {
  let comprehensiveText = baseText;

  // 1. 마크다운 변환
  comprehensiveText = convertMarkdownToText(comprehensiveText);

  // 2. 이모지 변환
  comprehensiveText = convertEmojis(comprehensiveText);

  // 3. blocks에서 추가 정보 추출
  if (blocks && blocks.length > 0) {
    // section blocks에서 추가 텍스트 찾기
    blocks.forEach((block) => {
      if (block.type === 'section' && block.text?.text) {
        const blockText = convertMarkdownToText(block.text.text);
        // 기본 텍스트에 없는 중요한 정보가 있으면 추가
        if (blockText.length > comprehensiveText.length + 50) {
          const additionalInfo = blockText.substring(comprehensiveText.length).trim();
          if (additionalInfo) {
            comprehensiveText += ` ${additionalInfo}`;
          }
        }
      }

      // 버튼 정보 추출
      if (block.accessory?.type === 'button') {
        const button: MessageButton = {
          text: block.accessory.text?.text || 'Button',
          style: block.accessory.style,
          url: block.accessory.url,
        };
        if (!options.buttons) options.buttons = [];
        options.buttons.push(button);
      }

      // actions 블록에서 버튼들 추출
      if (block.type === 'actions' && block.elements) {
        block.elements.forEach((element: any) => {
          if (element.type === 'button') {
            const button: MessageButton = {
              text: element.text?.text || 'Button',
              style: element.style,
              url: element.url,
            };
            if (!options.buttons) options.buttons = [];
            options.buttons.push(button);
          }
        });
      }
    });
  }

  // 4. 추가 정보들 포맷팅하여 추가
  let additionalInfo = '';

  // 링크 정보
  if (options.links && options.links.length > 0) {
    additionalInfo += ` Links: ${formatLinks(options.links)}`;
  }

  // diff 요약
  if (options.diffSummary) {
    additionalInfo += formatDiffSummary(options.diffSummary);
  }

  // 버튼 정보
  if (options.buttons && options.buttons.length > 0) {
    additionalInfo += formatButtons(options.buttons);
  }

  // 메타데이터
  if (options.metadata) {
    const importantMeta = [];
    if (options.metadata.fileName) importantMeta.push(`File: ${options.metadata.fileName}`);
    if (options.metadata.sectionName) importantMeta.push(`Section: ${options.metadata.sectionName}`);
    if (options.metadata.lineCount) importantMeta.push(`${options.metadata.lineCount} lines`);

    if (importantMeta.length > 0) {
      additionalInfo += ` (${importantMeta.join(', ')})`;
    }
  }

  return (comprehensiveText + additionalInfo).trim();
}

/**
 * postMessage 호출을 래핑하여 자동으로 포괄적인 text 생성
 */
export function createEnhancedMessage(
  baseMessage: {
    text: string;
    blocks?: any[];
    [key: string]: any;
  },
  options: MessageOptions = {},
): typeof baseMessage {
  return {
    ...baseMessage,
    text: createComprehensiveText(baseMessage.text, baseMessage.blocks || [], options),
  };
}

/**
 * 문서 업데이트 메시지용 특별 헬퍼
 */
export function createDocumentUpdateText(
  fileName: string,
  userName: string,
  sectionName: string,
  githubUrl: string,
  diffContent?: any, // Can be rich text object or string
  buttons?: MessageButton[],
): string {
  let text = `✅ Document Updated: ${fileName} by ${userName}`;

  if (sectionName) {
    text += ` - Section: ${sectionName}`;
  }

  if (githubUrl) {
    text += ` (view at ${githubUrl})`;
  }

  if (diffContent) {
    text += formatDiffSummary(diffContent);
  }

  if (buttons && buttons.length > 0) {
    text += formatButtons(buttons);
  }

  return text;
}
