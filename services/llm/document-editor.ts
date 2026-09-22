import type { WebClient } from '@slack/web-api';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Logger } from 'services/common/logger';
import { anonymizeText } from 'services/common/name-cache';
import { processMessageHistory } from 'services/slack/conversation-history';
import { createChatCompletion, createStructuredResponse } from './completions';
import { contentLanguageDirective, getContentLanguagePolicy } from './content-language';

export async function editMarkdownWithKnowledge(
  markdown: string,
  knowledgeContent: string,
  context?: { fileName?: string; sectionName?: string; headingPath?: string },
  workspaceId?: string,
) {
  const anonymizedKnowledge = anonymizeText(knowledgeContent, workspaceId);
  const isEmpty = !markdown.trim();

  // 빈 섹션과 기존 내용에 대해 다른 프롬프트 사용
  if (isEmpty) {
    return await createContentForEmptySection(anonymizedKnowledge, context, workspaceId);
  }
  return await enhanceExistingContent(markdown, anonymizedKnowledge, context, workspaceId);
}

/**
 * 빈 섹션에 대해 새로운 내용 생성
 */
async function createContentForEmptySection(
  knowledgeContent: string,
  context: { fileName?: string; sectionName?: string; headingPath?: string } | undefined,
  workspaceId: string | undefined,
) {
  const contextInfo = context?.headingPath || context?.sectionName || 'Unknown section';

  const languageDirective = contentLanguageDirective(await getContentLanguagePolicy(workspaceId), {
    source: 'knowledge',
    followSuffix: ', unless the FILE/SECTION context is clearly in another language, in which case match the document',
  });

  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a documentation writer. Create content for an empty section using only the provided knowledge.

Rules:
- Use only information from the knowledge (no external details)
${languageDirective}
- Write as paragraphs or simple list items (no headings)
- Keep content concise and relevant to the section
- Preserve all URLs from the knowledge
- Use single-level lists only (no nested bullets)
- Return empty string if knowledge is insufficient`,
      },
      {
        role: 'user',
        content: `FILE: ${context?.fileName || 'Unknown'}
SECTION: ${contextInfo}

KNOWLEDGE:
${knowledgeContent}

Generate content for this section:`,
      },
    ],
    {
      workspaceId,
      purpose: 'document-update',
      temperature: 0,
      max_tokens: 300,
      function_name: 'createContentForEmptySection',
    },
  );

  return response?.trim() || '';
}

/** A GFM delimiter row: `|---|---|`, `| :--- | ---: |`, `---|:-:`. */
const GFM_DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/**
 * What kind of block the existing content is, so the edit prompt can tell the
 * model to keep that shape.
 *
 * A GFM table used to fall through to 'paragraph', and the prompt then told the
 * model to append "additional paragraphs" — which produced prose glued under the
 * table, or the table rewritten as prose. Since the caller replaces the whole
 * block with whatever comes back (see `applyAnchorReplacement`), that reshaping
 * landed in the committed file.
 */
export function detectExistingContentType(markdown: string): 'list' | 'table' | 'paragraph' {
  const lines = markdown.split('\n').filter((line) => line.trim());

  // A table needs a header row with a pipe and a delimiter row right under it.
  // The delimiter row must itself contain a pipe, so a `---` rule (or a setext
  // underline) below a line that merely happens to contain a `|` is not a table.
  if (
    lines.length >= 2 &&
    lines[0].includes('|') &&
    lines[1].includes('|') &&
    GFM_DELIMITER_ROW.test(lines[1].trim())
  ) {
    return 'table';
  }

  return markdown.trim().match(/^(\s*[-*+]|\s*\d+\.)\s/) ? 'list' : 'paragraph';
}

/** A line that opens a list item: `- x`, `* x`, `+ x`, `1. x`. */
const LIST_MARKER = /^\s*([-*+]|\d+\.)\s/;

/**
 * Split one GFM table row into trimmed cells.
 *
 * Optional leading and trailing pipes are dropped (so `| a | b |` and `a | b`
 * both yield two cells) and `\|` stays inside the cell it escapes instead of
 * splitting it.
 */
function splitTableCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') {
      current += '\\|';
      i++;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);

  // `| a | b |` splits into ['', ' a ', ' b ', ''] — the pipes at the edges are
  // delimiters, not empty cells.
  if (cells.length > 1 && !cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 1 && !cells[cells.length - 1].trim()) {
    cells.pop();
  }

  return cells.map((cell) => cell.trim());
}

/** Cell text for comparison: trimmed, with runs of internal whitespace collapsed. */
function normalizeCell(cell: string): string {
  return cell.replace(/\s+/g, ' ').trim();
}

interface ParsedTable {
  header: string;
  delimiter: string;
  body: string[];
  /** Lines after the table block, in order, blank lines included. */
  rest: string[];
}

/**
 * Read a table off the top of `text`: a header row containing a pipe, a
 * delimiter row, then consecutive lines that contain a pipe. Returns null when
 * the text does not begin with a table.
 *
 * `ignoreBlankLines` is for the original block, which `detectExistingContentType`
 * also reads with blank lines stripped; the candidate is parsed strictly so that
 * a blank line genuinely ends the table block.
 */
function parseLeadingTable(text: string, ignoreBlankLines: boolean): ParsedTable | null {
  const all = text.trim().split('\n');
  const lines = ignoreBlankLines ? all.filter((line) => line.trim()) : all;
  if (lines.length < 2 || !lines[0].includes('|') || !GFM_DELIMITER_ROW.test(lines[1].trim())) {
    return null;
  }

  const body: string[] = [];
  let index = 2;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || !line.includes('|')) {
      break;
    }
    body.push(line);
  }

  return { header: lines[0], delimiter: lines[1], body, rest: lines.slice(index) };
}

export type TableEditValidation = { ok: true } | { ok: false; reason: string };

/**
 * Hard guard on an LLM table edit.
 *
 * The prompt asks the model to return the complete table with the same shape,
 * but the caller replaces the whole original block with the reply
 * (`applyAnchorReplacement`, or the node splice in `document-updater`), so an
 * instruction is not enough: a truncated or reshaped answer would be committed.
 * This re-checks the answer against the original and, when it fails, hands back
 * a reason short enough to put in both the log and the retry prompt.
 */
export function validateTableEdit(original: string, candidate: string): TableEditValidation {
  const before = parseLeadingTable(original, true);
  if (!before) {
    // Not a table to begin with — nothing for this guard to protect.
    return { ok: true };
  }

  const after = parseLeadingTable(candidate, false);
  if (!after) {
    return {
      ok: false,
      reason:
        'the reply does not start with a table (a header row and a |---| delimiter row must come first, with nothing before them)',
    };
  }

  const tail = [...after.rest];
  while (tail.length && !tail[0].trim()) {
    tail.shift();
  }
  while (tail.length && !tail[tail.length - 1].trim()) {
    tail.pop();
  }
  if (tail.length) {
    if (tail.some((line) => !line.trim())) {
      return { ok: false, reason: 'content after the table: at most one short paragraph may follow it' };
    }
    if (tail.some((line) => line.includes('|'))) {
      return { ok: false, reason: 'content after the table: the rows must all be inside the one table' };
    }
    if (tail.some((line) => LIST_MARKER.test(line) || line.trimStart().startsWith('#'))) {
      return { ok: false, reason: 'content after the table: a list or heading follows the table' };
    }
  }

  const expectedHeader = splitTableCells(before.header);
  const actualHeader = splitTableCells(after.header);
  const columns = expectedHeader.length;

  if (actualHeader.length !== columns) {
    return {
      ok: false,
      reason: `the header row has ${actualHeader.length} columns but the original has ${columns}`,
    };
  }

  const expectedNames = expectedHeader.map(normalizeCell);
  const actualNames = actualHeader.map(normalizeCell);
  if (expectedNames.some((name, i) => name !== actualNames[i])) {
    return {
      ok: false,
      reason: `the header row changed: it must stay exactly "${expectedNames.join(' | ')}"`,
    };
  }

  const delimiterCells = splitTableCells(after.delimiter).length;
  if (delimiterCells !== columns) {
    return {
      ok: false,
      reason: `the delimiter row has ${delimiterCells} cells but the table has ${columns} columns`,
    };
  }

  for (let i = 0; i < after.body.length; i++) {
    const cells = splitTableCells(after.body[i]).length;
    if (cells !== columns) {
      return {
        ok: false,
        reason: `row ${i + 1} has ${cells} cells but the table has ${columns} columns`,
      };
    }
  }

  if (after.body.length < before.body.length) {
    return {
      ok: false,
      reason: `the table has ${after.body.length} rows but the original has ${before.body.length}; every original row must be kept`,
    };
  }

  // A completion cut off mid-row leaves that row without its closing pipe, which
  // is only a signal when the original closed every row.
  const originalRowsClosed = before.body.length > 0 && before.body.every((line) => line.trim().endsWith('|'));
  if (originalRowsClosed) {
    const unterminated = after.body.findIndex((line) => !line.trim().endsWith('|'));
    if (unterminated !== -1) {
      return {
        ok: false,
        reason: `row ${unterminated + 1} does not end with "|", so the table looks truncated`,
      };
    }
  }

  return { ok: true };
}

/**
 * Room for the answer. 500 tokens truncated any table bigger than a handful of
 * rows, and because the caller replaces the whole block with the reply, the
 * truncated table overwrote the complete one in the commit. The model has to be
 * able to echo the whole input back plus its edits, so scale the budget with the
 * input (~2 chars/token, a deliberately pessimistic ratio that also covers CJK
 * tables) with a floor for short blocks and a cap so a huge section cannot bill
 * an unbounded completion.
 */
function outputTokenBudget(markdown: string): number {
  return Math.min(4000, Math.max(1500, Math.ceil(markdown.length / 2) + 500));
}

/**
 * 기존 내용을 knowledge로 향상 (업데이트 우선, 필요시 추가)
 */
async function enhanceExistingContent(
  markdown: string,
  knowledgeContent: string,
  context: { fileName?: string; sectionName?: string; headingPath?: string } | undefined,
  workspaceId: string | undefined,
) {
  const contextInfo = context?.headingPath || context?.sectionName || 'Unknown section';

  // 기존 markdown 내용을 분석해서 타입 감지
  const contentType = detectExistingContentType(markdown);

  const matchingFormat =
    contentType === 'list'
      ? 'as additional list items (- format)'
      : contentType === 'table'
        ? 'as additional rows of the existing table, using the same columns in the same order'
        : 'as additional paragraphs';

  const tableRules =
    contentType === 'table'
      ? `

The existing content is a GFM markdown table. These table rules override anything above that would reshape it:
- Keep the exact table structure: the same columns in the same order, the same header row, the same delimiter row, one row per line, cells separated by \`|\`
- When the knowledge changes a value, update that cell in place
- When the knowledge adds entries, add new rows in the same column layout
- Never convert the table into prose or into a list, and never drop, add or reorder columns
- Do not add paragraphs above or below the table unless the knowledge genuinely cannot be expressed as a row; in that case a single short paragraph after the table is acceptable
- Return the COMPLETE table — every original row plus your changes — never a partial or truncated table`
      : '';

  const languageDirective = contentLanguageDirective(await getContentLanguagePolicy(workspaceId), {
    source: 'existing-content',
  });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a document editor. Improve existing content by integrating the provided knowledge.

Existing content type: ${contentType}

Rules:
${languageDirective}
- PRIORITIZE updating/replacing existing content when knowledge provides better, more accurate, or more comprehensive information
- If knowledge contradicts existing content, prefer the knowledge (assume it's more current/accurate)
- If knowledge complements existing content without contradiction, add it in matching format: ${matchingFormat}
- If knowledge provides more specific details about existing points, merge them into improved versions
- Preserve all URLs from the knowledge
- Use single-level lists only (no nested bullets)
- No headings or section titles
- Return original only if knowledge adds no meaningful value${tableRules}

Approach: Update first, then add if needed. Create the most accurate and comprehensive version.

Return ONLY the updated markdown content, nothing else.`,
    },
    {
      role: 'user',
      content: `File: ${context?.fileName || 'Unknown'} - Section: ${contextInfo}

Existing content:
${markdown}

Knowledge to integrate:
${knowledgeContent}`,
    },
  ];

  const options = {
    workspaceId,
    purpose: 'document-update' as const,
    temperature: 0,
    max_tokens: outputTokenBudget(markdown),
    function_name: 'enhanceExistingContent',
  };

  const response = await createChatCompletion(messages, options);
  const edited = response?.trim() || markdown;

  if (contentType !== 'table' || edited === markdown) {
    return edited;
  }

  // The prompt asks for the whole table back, but the caller commits whatever
  // comes out of here, so verify the shape before trusting it.
  const firstCheck = validateTableEdit(markdown, edited);
  if (firstCheck.ok) {
    return edited;
  }

  Logger.warn('Table edit did not keep the table structure; retrying once', {
    fileName: context?.fileName,
    workspaceId,
    operation: 'enhanceExistingContent',
    reason: firstCheck.reason,
  });

  const retryResponse = await createChatCompletion(
    [...messages, { role: 'user', content: tableRetryInstruction(firstCheck.reason) }],
    { ...options, function_name: 'enhanceExistingContent.retry' },
  );
  const retried = retryResponse?.trim();
  if (!retried) {
    return markdown;
  }

  const secondCheck = validateTableEdit(markdown, retried);
  if (secondCheck.ok) {
    return retried;
  }

  Logger.warn('Table edit still malformed after retry; keeping the original content', {
    fileName: context?.fileName,
    workspaceId,
    operation: 'enhanceExistingContent',
    reason: secondCheck.reason,
  });

  return markdown;
}

/** The corrective turn appended before the single retry of a failed table edit. */
function tableRetryInstruction(reason: string): string {
  return `Your previous reply did not keep the table structure: ${reason}. Return the complete table again with the same columns and header, every original row, one row per line. Return ONLY the table.`;
}

export async function classifyMessageIntent(
  message: string,
  organizationName: string,
  descOrg: string,
  messageHistory?: any[],
  client?: WebClient,
  workspaceId?: string,
): Promise<'question' | 'update_request' | 'general_conversation'> {
  // Anonymize the input message
  const anonymizedMessage = anonymizeText(message, workspaceId);

  // Build context from message history if available using centralized processMessageHistory
  let contextSection = '';
  if (messageHistory && messageHistory.length > 0 && client) {
    const processedMessages = await processMessageHistory(messageHistory, client);

    if (processedMessages.length > 0) {
      const contextMessages = processedMessages.map((msg: any) => msg.content).join('\n');
      contextSection = `\n\nRecent conversation context:\n${contextMessages}\n\nUse this context to better understand the intent of the current message.`;
    }
  }

  const systemPrompt = `Classify the user message for an organizational knowledge management system (a bot that documents team knowledge from conversations).
- 'update_request': providing new information/facts/decisions to document, OR asking to save, update, record, capture, write down, or summarize/organize THE CURRENT conversation or discussion. The goal is to write something into the documentation.
- 'question': seeking information that may already be in the documentation — asking about an existing policy, procedure, schedule, rule, tool, or fact (including "summarize/explain our X" where X is an existing topic, not the current chat).
- 'general_conversation': greetings, thanks, chit-chat, or meta-questions about the bot itself.

Key distinction: summarizing/organizing the CURRENT conversation or discussion = 'update_request'; summarizing/explaining an EXISTING topic = 'question'.
When in doubt between 'question' and 'general_conversation', prefer 'question'.
${organizationName ? `\nOrganization: ${organizationName}` : ''}${descOrg ? `\nAbout: ${descOrg}` : ''}${contextSection}`;

  try {
    const result = await createStructuredResponse<{ intent: 'question' | 'update_request' | 'general_conversation' }>(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: anonymizedMessage },
      ],
      {
        workspaceId,
        purpose: 'classification',
        temperature: 0,
        // The classification model is a reasoning (nano) model, whose reasoning
        // tokens count against max_output_tokens. 16 was consumed entirely by
        // reasoning, leaving no room for the JSON — so parsing failed and every
        // message silently fell back to 'general_conversation'. Give enough room
        // for reasoning plus the tiny structured output.
        max_tokens: 2000,
        function_name: 'classifyMessageIntent',
        schemaName: 'message_intent',
        schemaDescription: 'Classification of user message intent',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            intent: {
              type: 'string',
              enum: ['question', 'update_request', 'general_conversation'],
            },
          },
          required: ['intent'],
        },
      },
    );
    return result.intent;
  } catch (error) {
    console.warn('Failed to classify message intent:', error);
    return 'general_conversation';
  }
}
