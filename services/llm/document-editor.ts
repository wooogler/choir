import type { WebClient } from '@slack/web-api';
import { anonymizeText } from 'services/common/name-cache';
import { processMessageHistory } from 'services/slack/conversation-history';
import { createChatCompletion, createStructuredResponse } from './completions';

export async function editMarkdownWithKnowledge(
  markdown: string,
  knowledgeContent: string,
  context?: { fileName?: string; sectionName?: string; headingPath?: string },
  workspaceId?: string,
) {
  const anonymizedKnowledge = anonymizeText(knowledgeContent);
  const isEmpty = !markdown.trim();

  // 빈 섹션과 기존 내용에 대해 다른 프롬프트 사용
  if (isEmpty) {
    return await createContentForEmptySection(anonymizedKnowledge, context, workspaceId);
  } else {
    return await enhanceExistingContent(markdown, anonymizedKnowledge, context, workspaceId);
  }
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

  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a documentation writer. Create content for an empty section using only the provided knowledge.

Rules:
- Use only information from the knowledge (no external details)
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
  const contentType = markdown.trim().match(/^(\s*[-*+]|\s*\d+\.)\s/) ? 'list' : 'paragraph';

  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a document editor. Improve existing content by integrating the provided knowledge.

Existing content type: ${contentType}

Rules:
- PRIORITIZE updating/replacing existing content when knowledge provides better, more accurate, or more comprehensive information
- If knowledge contradicts existing content, prefer the knowledge (assume it's more current/accurate)
- If knowledge complements existing content without contradiction, add it in matching format: ${contentType === 'list' ? 'as additional list items (- format)' : 'as additional paragraphs'}
- If knowledge provides more specific details about existing points, merge them into improved versions
- Preserve all URLs from the knowledge
- Use single-level lists only (no nested bullets)
- No headings or section titles
- Return original only if knowledge adds no meaningful value

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
    ],
    {
      workspaceId,
      purpose: 'document-update',
      temperature: 0,
      max_tokens: 500,
      function_name: 'enhanceExistingContent',
    },
  );

  return response?.trim() || markdown;
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
  const anonymizedMessage = anonymizeText(message);

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
        max_tokens: 16,
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
