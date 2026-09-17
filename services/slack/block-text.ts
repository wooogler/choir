// Slack section block `text.text` is capped at 3000 characters; a longer answer
// makes the whole message fail with invalid_blocks. Split long mrkdwn into
// chunks under the cap, preferring to break on paragraph, then line, then word
// boundaries so formatting stays intact. A single token longer than the cap is
// hard-split as a last resort.
export const SLACK_SECTION_TEXT_LIMIT = 3000;

export function chunkTextForBlocks(text: string, maxLen: number = SLACK_SECTION_TEXT_LIMIT): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  const flushAt = (index: number) => {
    chunks.push(remaining.slice(0, index).replace(/\s+$/, ''));
    remaining = remaining.slice(index).replace(/^\s+/, '');
  };

  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    // Prefer the last paragraph break, then newline, then space, within the window.
    const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    if (breakAt > 0) {
      flushAt(breakAt);
    } else {
      // No whitespace to break on (e.g. a very long URL/token): hard split.
      flushAt(maxLen);
    }
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface MrkdwnSectionBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
  block_id?: string;
}

/**
 * Renders mrkdwn text as one or more Slack section blocks, each within the
 * character cap. The first block carries `blockId` (if given); the rest omit it,
 * since Slack requires block_ids to be unique within a message.
 *
 * `maxBlocks` bounds the output: an enormous section would otherwise produce more
 * blocks than Slack allows in a single surface (100 in a modal, 50 in a message),
 * failing the whole view with invalid_blocks. When the text needs more blocks than
 * the cap, the last block is replaced with a truncation notice.
 *
 * `truncationNotice` lets a caller that knows who is reading write that notice in
 * their language; it receives the omitted-character count already grouped for
 * display. Callers that do not pass one keep the English notice this function has
 * always produced.
 */
export function buildSectionBlocks(
  text: string,
  blockId?: string,
  options?: { maxBlocks?: number; truncationNotice?: (characters: string) => string },
): MrkdwnSectionBlock[] {
  const chunks = chunkTextForBlocks(text);
  if (chunks.length === 0) return [];

  const maxBlocks = options?.maxBlocks;
  let rendered = chunks;
  let truncated = false;
  if (maxBlocks !== undefined && maxBlocks > 0 && chunks.length > maxBlocks) {
    // Keep room for the truncation notice as the final block.
    rendered = chunks.slice(0, maxBlocks - 1);
    truncated = true;
  }

  const blocks: MrkdwnSectionBlock[] = rendered.map((chunk, index) => ({
    type: 'section' as const,
    text: { type: 'mrkdwn' as const, text: chunk },
    ...(index === 0 && blockId ? { block_id: blockId } : {}),
  }));

  if (truncated) {
    const shownChars = rendered.reduce((sum, chunk) => sum + chunk.length, 0);
    const omittedChars = (text.length - shownChars).toLocaleString();
    blocks.push({
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text:
          options?.truncationNotice?.(omittedChars) ??
          `_… preview truncated (${omittedChars} more characters not shown)_`,
      },
    });
  }

  return blocks;
}
