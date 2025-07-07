import type { WebClient } from '@slack/web-api';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { SlackMessage } from 'services/slack';
import { getUserName, isBotUser } from 'services/slack';
import { getAnonymizationMapping, anonymizeText } from 'services/common/name-cache';
import { createChatCompletion } from './completions';

// Format context from documents
const formatContext = (docs: any[]) => {
  return docs.map((doc) => `File: ${doc.metadata.fileName}\nContent: ${doc.pageContent}`).join('\n\n');
};

// Process message history with filtering and mention processing
const processMessageHistory = async (messages: any[], client?: WebClient) => {
  const filteredMessages = messages.filter((msg) => {
    // Basic filters
    if (!msg.text || msg.subtype) return false;

    // Filter out loading and temporary messages, including reclassification notifications
    const loadingPatterns = [
      'Searching relevant documents',
      'Preparing document update suggestions',
      'Processing knowledge and generating',
      ':mag:',
      ':brain:',
      'Extracting knowledge from',
      'Analyzing conversation',
      'let me know this was actually a question',
      'clarified this was a suggestion for updating our docs',
      ':thinking_face:',
      ':memo:',
    ];

    // Check if message contains any loading patterns
    const isLoadingMessage = loadingPatterns.some((pattern) => msg.text.includes(pattern));

    return !isLoadingMessage;
  });

  // Process mentions if client is provided
  const processedMessages = client
    ? await Promise.all(
        filteredMessages.map(async (msg) => ({
          ...msg,
          text: await processMessageText(msg.text, client),
        })),
      )
    : filteredMessages;

  return await Promise.all(
    processedMessages.reverse().map(async (msg) => {
      let role = msg.bot_id ? 'assistant' : 'user';
      let content = msg.text;
      
      // For user messages, add anonymized username
      if (!msg.bot_id && msg.user && client) {
        const userName = await getUserName(msg.user, client);
        const anonymizationMapping = getAnonymizationMapping(msg.user, userName);
        content = `${anonymizationMapping.fakeNickname}: ${msg.text}`;
      }
      
      return {
        role,
        content,
      };
    })
  );
};

// Process message text to handle user and bot mentions
export async function processMessageText(text: string, client: WebClient): Promise<string> {
  // Regular expression to find all user/bot mentions like <@U089Q1VAB3J>
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let matches;
  let processedText = text;

  // Get current bot user ID
  const authResult = await client.auth.test();
  const currentBotId = authResult.user_id;

  // Collect all unique user IDs mentioned in the text
  const mentionedIds = new Set<string>();
  while ((matches = mentionRegex.exec(text)) !== null) {
    mentionedIds.add(matches[1]);
  }

  // Process each unique user ID
  for (const userId of mentionedIds) {
    const isBot = await isBotUser(userId, client);

    if (isBot) {
      if (userId === currentBotId) {
        // Replace current chatbot mention with @CHOIR
        processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '@CHOIR');
      } else {
        // Remove other bot mentions completely
        processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), '');
      }
    } else {
      // Replace user mentions with anonymized names
      const userName = await getUserName(userId, client);
      const anonymizationMapping = getAnonymizationMapping(userId, userName);
      processedText = processedText.replace(new RegExp(`<@${userId}>`, 'g'), anonymizationMapping.fakeNickname);
    }
  }

  // Apply general text anonymization for any remaining real names
  const anonymizedText = anonymizeText(processedText);
  
  return anonymizedText.trim();
}

// Interface for answer result
interface AnswerResult {
  canAnswer: boolean;
  response: string;
}

// Generate completion with context
export const answerQuestion = async (
  userMessage: string,
  messageHistory: any[],
  relevantDocs: any[],
  client?: WebClient,
  workspaceName?: string,
  organizationName?: string,
  organizationDescription?: string,
): Promise<AnswerResult> => {
  const context = formatContext(relevantDocs);
  const messages = await processMessageHistory(messageHistory, client);
  
  // Anonymize the user message
  const anonymizedUserMessage = anonymizeText(userMessage);

  // Get today's date
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const prompt = `You are CHOIR, a helpful AI assistant for ${organizationName || 'the organization'}. Think of yourself as a knowledgeable senior student or friendly professor who's always ready to help with questions.

I have access to the organization's documentation and knowledge base, so I can help you find information and provide guidance based on what we have documented.

Organization Information:
${organizationName ? `- Organization: ${organizationName}` : ''}
${organizationDescription ? `- About: ${organizationDescription}` : ''}
- Today's date: ${today}
${workspaceName ? `- Workspace: ${workspaceName}` : ''}

IMPORTANT: First, determine if you can answer the user's question based ONLY on the provided documentation. Do NOT use your general knowledge or make assumptions beyond what's explicitly stated in the documents.

Then respond with a JSON object containing:
1. "canAnswer": true/false - whether the documentation contains sufficient information to answer the question
2. "response": your answer based on the documentation, or a friendly explanation that you couldn't find the information

Examples of expected output:

Example 1 (can answer):
{
  "canAnswer": true,
  "response": "According to our documentation, you can submit a pull request by first forking the repository, making your changes, and then creating a pull request from your fork. The process is outlined in our contributing guidelines document."
}

Example 2 (cannot answer):
{
  "canAnswer": false,
  "response": "I couldn't find information about deployment procedures in our current documentation. This seems like an important topic that would benefit from being documented! Could you ask others who might have this knowledge, or perhaps start a discussion about creating deployment documentation?"
}

Guidelines for answering:
- Be friendly, approachable, and helpful - like a senior colleague who genuinely wants to help
- Answer ONLY based on the provided documentation below - do NOT add general knowledge
- If multiple documents contain conflicting information, prioritize the first document in the list
- If you cannot answer based on the documentation, encourage the user to ask others or start a discussion to help improve our documentation
- When users mention @CHOIR, that's me! Feel free to be conversational
- Use a warm, academic tone - professional but not overly formal

Here's the relevant documentation I can reference:
${context}

User's conversation history:
${messages.map((m) => `${m.role}: ${m.content}`).join('\n')}

Current question: ${anonymizedUserMessage}

Analyze whether you can answer based on the documentation and provide your response as JSON:`;

  const result = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          "You are a helpful documentation assistant that answers questions based only on provided documents. Always respond with a JSON object containing 'canAnswer' (boolean) and 'response' (string).",
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    {
      model: 'gpt-4o',
      temperature: 0.2,
      max_tokens: 1000,
      function_name: 'answerQuestion',
      debug: true,
      response_format: { type: 'json_object' },
    },
  );

  try {
    let jsonString = result?.trim() || '{}';

    // Remove markdown code block markers if present
    if (jsonString.startsWith('```json')) {
      jsonString = jsonString.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonString.startsWith('```')) {
      jsonString = jsonString.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(jsonString);

    return {
      canAnswer: parsed.canAnswer || false,
      response: parsed.response || 'I encountered an error processing your question.',
    };
  } catch (parseError) {
    console.warn('Failed to parse JSON response from answerQuestion:', parseError);
    console.warn('Raw response:', result);

    return {
      canAnswer: false,
      response:
        "I couldn't find this information in our current documentation. Could you help by asking others or starting a discussion about this topic?",
    };
  }
};
