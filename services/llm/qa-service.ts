import type { WebClient } from '@slack/web-api';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { anonymizeText, getAnonymizationMapping } from 'services/common/name-cache';
import { SlackMessage } from 'services/slack';
import { getUserName } from 'services/slack';
import { processMessageHistory, processMessageText } from 'services/slack/conversation-history';
import { createChatCompletion } from './completions';

// Format context from documents
const formatContext = (docs: any[]) => {
  return docs.map((doc, index) => {
    const title = doc.metadata?.title || doc.metadata?.source || `Document ${index + 1}`;
    return `--- ${title} ---\n${doc.pageContent}`;
  }).join('\n\n');
};

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

  // Get the current user from the most recent message to format current question
  let currentQuestionWithUser = userMessage;
  if (messageHistory.length > 0 && client) {
    const lastMessage = messageHistory[messageHistory.length - 1];
    if (lastMessage.user) {
      try {
        const userName = await getUserName(lastMessage.user, client);
        const anonymizationMapping = getAnonymizationMapping(lastMessage.user, userName);
        currentQuestionWithUser = `${anonymizationMapping.fakeNickname}: ${userMessage}`;
      } catch (error) {
        // Fallback to just the message if user name lookup fails
        currentQuestionWithUser = userMessage;
      }
    }
  }

  // Anonymize the final message
  const anonymizedCurrentQuestion = anonymizeText(currentQuestionWithUser);

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

==== DOCUMENTATION ====
${context}

==== CONVERSATION HISTORY ====
${messages.map((m) => m.content).join('\n')}

==== CURRENT QUESTION ====
${anonymizedCurrentQuestion}

Analyze whether you can answer based on the documentation and provide your response as JSON:`;

  const result = await createChatCompletion(
    [
      {
        role: 'system',
        content:
          "You are CHOIR, a helpful documentation assistant that answers questions based only on provided documents. Always respond with a JSON object containing 'canAnswer' (boolean) and 'response' (string).",
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
