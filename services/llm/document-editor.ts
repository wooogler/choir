import type { WebClient } from '@slack/web-api';
import { anonymizeText, getAnonymizationMapping } from 'services/common/name-cache';
import type { SlackMessage } from 'services/slack';
import { getUserName } from 'services/slack';
import { processMessageHistory, processMessageText } from 'services/slack/conversation-history';
import { createChatCompletion } from './completions';

export async function editMarkdownWithUserMessages(markdown: string, userMessages: SlackMessage[], client: WebClient) {
  // Process message texts to handle mentions and anonymize content
  const processedMessages = await Promise.all(
    userMessages.map(async (message) => {
      const processedText = await processMessageText(message.text, client);

      // Get anonymized username using consistent name-cache system
      let anonUser = 'Unknown';
      if (message.userId) {
        const userName = await getUserName(message.userId, client);
        const anonymizationMapping = getAnonymizationMapping(message.userId, userName);
        anonUser = anonymizationMapping.fakeNickname;
      } else if (message.username) {
        // Fallback: anonymize username directly if no userId field
        anonUser = anonymizeText(message.username);
      }

      return {
        anonUser,
        text: processedText,
      };
    }),
  );

  const responseContent = await createChatCompletion(
    [
      {
        role: 'system',
        content: `As a document editor, modify this markdown document with information from the conversation.

Key rules:
1. Update information: Directly modify existing content when needed and only add important new information
2. Keep it concise: Make minimal edits while maintaining the document's original style and tone
3. When conversation mentions contradict existing content, replace the existing content with new information
4. Never include user identifiers or names
5. Return only the edited markdown without explanations or tags`,
      },
      {
        role: 'user',
        content: `<markdown>${markdown}</markdown>
<conversation>
${processedMessages.map((message) => `${message.anonUser}: ${message.text}`).join('\n')}
</conversation>`,
      },
    ],
    {
      model: 'gpt-4o-mini',
      temperature: 0,
      function_name: 'editMarkdownWithUserMessages',
      debug: true,
    },
  );

  // Remove any markdown tags from the response
  return responseContent?.replace(/<\/?markdown>/g, '') ?? markdown;
}

export async function editMarkdownWithKnowledge(markdown: string, knowledgeContent: string) {
  // Anonymize the knowledge content before sending to LLM
  const anonymizedKnowledge = anonymizeText(knowledgeContent);

  const responseContent = await createChatCompletion(
    [
      {
        role: 'system',
        content: `As a document editor, modify this markdown document with the provided knowledge.

Key rules:
1. Update information: Directly modify existing content when needed and only add important new information
2. Keep it concise: Make minimal edits while maintaining the document's original style and tone
3. When knowledge contradicts existing content, completely replace the conflicting content with the new information (do not keep both)
4. If the knowledge is already covered or adds no new value, return the original document unchanged (do not add redundant content)
5. Never include user identifiers or names
6. Return only the edited markdown without explanations or tags
7. Focus on incorporating the knowledge into the most relevant section of the document`,
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
      model: 'gpt-4o-mini',
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

  const systemPrompt = `You are an intelligent agent that answers questions or helps update documents that manages the institutional knowledge or polices of an organization, such as a university research lab.
Your task is to classify the user message as 'question' (asking for information about the organization), 'update_request' (containing new knowledge, information, or facts that could be documented, or explicitly asking to save/store information about the organization), or 'general_conversation' (a general statement, greeting, or chit-chat without substantial new information, questions that are not necessarily about the organization or the members).

Update_request includes: direct requests to save information about the organization, suggestions for document changes, AND statements containing new knowledge, facts, decisions, tools being used, processes, or any information that could be valuable for documentation.

Examples of update_request:

'I will use Microsoft Teams for online meeting'
'We decided to switch to React for the frontend'
'The API endpoint is now https://api.example.com'
'Please update the document'
'Please save this information'
- 'This document needs to be updated'

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

  // Log the classification result
  console.log(`[MESSAGE INTENT CLASSIFICATION]`, {
    originalMessage: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
    rawLLMResponse: result,
    classifiedAs: finalIntent,
    organizationName,
    descOrg,
  });

  return finalIntent;
}
