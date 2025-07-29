import type { WebClient } from '@slack/web-api';
import { anonymizeText, getAnonymizationMapping } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { getUserName } from 'services/slack';
import { processMessageHistory, processMessageText } from 'services/slack/conversation-history';
import { createChatCompletion } from './completions';

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
        content: `You are a documentation writer. Create content for an empty section using ONLY the provided knowledge.

CONSTRAINTS:
- Use ONLY information from the knowledge - no external details, links, or assumptions
- Write as one or multiple paragraphs or simple list items (no headings, subheadings, or complex structure)
- Keep content concise and directly relevant to the section context
- Never include user names or identifiers
- Always preserve any URLs from the knowledge as they contain valuable reference information
- If knowledge is insufficient for this section, return empty string

TASK: Write appropriate content for this section using only the provided knowledge.`,
      },
      {
        role: 'user',
        content: `FILE: ${context?.fileName || 'Unknown'}
SECTION: ${contextInfo}

KNOWLEDGE:
${knowledgeContent}

Generate content that fits this section context using only the provided knowledge:`,
      },
    ],
    {
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 300,
      function_name: 'createContentForEmptySection',
      debug: true,
    },
  );

  return response?.trim() || '';
}

/**
 * 기존 내용을 knowledge로 향상
 */
async function enhanceExistingContent(
  markdown: string,
  knowledgeContent: string,
  context?: { fileName?: string; sectionName?: string; headingPath?: string },
) {
  const contextInfo = context?.headingPath || context?.sectionName || 'Unknown section';

  const response = await createChatCompletion(
    [
      {
        role: 'system',
        content: `You are a document editor. Enhance the existing content by integrating the provided knowledge.

Rules:
- Use only the provided knowledge
- Keep existing content exactly as provided, do not modify its structure or formatting
- Add knowledge as new content that matches the existing format: if existing content contains list items, convert ALL knowledge content into additional list items; if paragraphs, add as paragraphs
- You may add new paragraphs or list items if the knowledge contains independent content
- Never include headings or section titles in your response
- Remove any user names or identifiers
- Always preserve any URLs from the knowledge as they contain valuable reference information
- Only update existing content if it directly contradicts the knowledge
- If knowledge adds nothing valuable, return the original unchanged

Wrap your response in <markdown> tags.`,
      },
      {
        role: 'user',
        content: `File: ${context?.fileName || 'Unknown'} - Section: ${contextInfo}

Existing content:
<markdown>
${markdown}
</markdown>

Knowledge to integrate:
${knowledgeContent}`,
      },
    ],
    {
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 500,
      function_name: 'enhanceExistingContent',
      debug: true,
    },
  );

  return response?.replace(/<\/?markdown>/g, '') || markdown;
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

  const systemPrompt = `You are CHOIR, an intelligent agent that answers questions or helps update documents that manages the institutional knowledge or polices of an organization, such as a university research lab.
Your task is to classify the user message as 'question' (asking for information about the organization), 'update_request' (containing new knowledge, information, or facts that could be documented, or explicitly asking to save/store information about the organization), or 'general_conversation' (a general statement, greeting, or chit-chat without substantial new information, questions that are not necessarily about the organization or the members).

Update_request includes: direct requests to save information about the organization, suggestions for document changes, AND statements containing new knowledge, facts, decisions, tools being used, processes, or any information that could be valuable for documentation.

Examples of update_request:
'I will use Microsoft Teams for online meeting'
'We decided to switch to React for the frontend'
'The API endpoint is now https://api.example.com'
'Please update the document'
'Please save this information'
'This document needs to be updated'

Examples of general_conversation:
'How do I use CHOIR?'
'What can you do?'
'How does CHOIR work?'
'What are your features?'
'How can I interact with you?'
'What commands do you support?'
'Hello'
'Hi there'
'Thanks'

Respond with only 'question', 'update_request', or 'general_conversation'.

Organization Context:
${organizationName ? `- Organization: ${organizationName}` : ''}
${descOrg ? `- About: ${descOrg}` : ''}${contextSection}`;

  const result = await createChatCompletion(
    [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: anonymizedMessage,
      },
    ],
    {
      temperature: 0.1,
      max_tokens: 15,
      function_name: 'classifyMessageIntent',
      debug: true,
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
    },
  );

  const classification = result?.trim().toLowerCase();
  let finalIntent: 'question' | 'update_request' | 'general_conversation';

  if (classification === 'update_request') {
    finalIntent = 'update_request';
  } else if (classification === 'question') {
    finalIntent = 'question';
  } else {
    finalIntent = 'general_conversation';
  }

  return finalIntent;
}
