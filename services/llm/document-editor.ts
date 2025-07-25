import type { WebClient } from '@slack/web-api';
import { anonymizeText, getAnonymizationMapping } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { getUserName } from 'services/slack';
import { processMessageHistory, processMessageText } from 'services/slack/conversation-history';
import { createChatCompletion } from './completions';

export async function editMarkdownWithKnowledge(markdown: string, knowledgeContent: string) {
  // Anonymize the knowledge content before sending to LLM
  const anonymizedKnowledge = anonymizeText(knowledgeContent);

  const responseContent = await createChatCompletion(
    [
      {
        role: 'system',
        content: `As a document editor, modify this markdown document by integrating the provided knowledge.

Your task: Update the existing content by merging new information rather than simply appending it.

Key rules:
1. **Integration over addition**: When new knowledge relates to existing content, modify the existing sentences to include the new details rather than adding separate sentences
2. **Replace contradictions**: When knowledge contradicts existing content, completely replace the conflicting content with the new information (do not keep both versions)
3. **Enhance specificity**: If new knowledge makes general statements more specific, update the general statement to include the specific details
4. **Preserve style**: Maintain the document's original tone and formatting style
5. **Skip redundant content**: If the knowledge is already covered or adds no new value, return the original document unchanged
6. **No user references**: Never include user identifiers or names
7. **Clean output**: Return only the edited markdown without explanations or tags`,
      },
      {
        role: 'user',
        content: `<markdown>${markdown}</markdown>
<knowledge>
${anonymizedKnowledge}
</knowledge>`,
      },
    ],
    {
      model: process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini',
      temperature: 0,
      function_name: 'editMarkdownWithKnowledge',
      debug: true,
    },
  );

  // Remove any markdown tags from the response
  return responseContent?.replace(/<\/?markdown>/g, '') ?? markdown;
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