import type { WebClient } from '@slack/web-api';
import { anonymizeText, getAnonymizationMapping } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { getUserName } from 'services/slack';
import { processMessageHistory, processMessageText } from 'services/slack/conversation-history';
import { createChatCompletion, createStructuredResponse } from './completions';

export async function editMarkdownWithKnowledge(
  markdown: string,
  knowledgeContent: string,
  context?: { fileName?: string; sectionName?: string; headingPath?: string },
) {
  const anonymizedKnowledge = anonymizeText(knowledgeContent);
  const isEmpty = !markdown.trim();

  // 빈 섹션과 기존 내용에 대해 다른 프롬프트 사용
  if (isEmpty) {
    return await createContentForEmptySection(anonymizedKnowledge, context);
  } else {
    return await enhanceExistingContent(markdown, anonymizedKnowledge, context);
  }
}

/**
 * 빈 섹션에 대해 새로운 내용 생성
 */
async function createContentForEmptySection(
  knowledgeContent: string,
  context?: { fileName?: string; sectionName?: string; headingPath?: string },
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
      model:
        process.env.OPENAI_RESPONSES_MODEL ||
        process.env.OPENAI_MODEL_NAME ||
        process.env.OPENAI_MODEL ||
        'gpt-4o-mini',
      temperature: 0,
      max_tokens: 300,
      function_name: 'createContentForEmptySection',
      debug: true,
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
  context?: { fileName?: string; sectionName?: string; headingPath?: string },
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
      model:
        process.env.OPENAI_RESPONSES_MODEL ||
        process.env.OPENAI_MODEL_NAME ||
        process.env.OPENAI_MODEL ||
        'gpt-4o-mini',
      temperature: 0,
      max_tokens: 500,
      function_name: 'enhanceExistingContent',
      debug: true,
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

  const systemPrompt = `Classify the user message for an organizational knowledge management system.
- 'question': seeking information that could be in the organization's documentation — policies, procedures, schedules, rules, tools, resources, or any factual knowledge about the organization
- 'update_request': providing new information to be documented, or requesting to save/update content
- 'general_conversation': greetings, chit-chat, meta-questions about this system, or browsing requests

When in doubt between 'question' and 'general_conversation', prefer 'question'.
${organizationName ? `\nOrganization: ${organizationName}` : ''}${descOrg ? `\nAbout: ${descOrg}` : ''}${contextSection}`;

  try {
    const result = await createStructuredResponse<{ intent: 'question' | 'update_request' | 'general_conversation' }>(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: anonymizedMessage },
      ],
      {
        temperature: 0,
        max_tokens: 16,
        function_name: 'classifyMessageIntent',
        debug: true,
        model:
          process.env.OPENAI_RESPONSES_MODEL ||
          process.env.OPENAI_MODEL_NAME ||
          process.env.OPENAI_MODEL ||
          'gpt-4o-mini',
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
