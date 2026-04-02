import type { WebClient } from '@slack/web-api';
import { getUserName } from 'services/slack';
import { processMessageHistory } from 'services/slack/conversation-history';
import { createStructuredResponse } from './completions';

// Format context from references
const formatContext = (docs: any[]) => {
  return docs
    .map((doc, index) => {
      const title = doc.metadata?.title || doc.metadata?.source || `Reference ${index + 1}`;
      return `--- ${title} ---\n${doc.pageContent}`;
    })
    .join('\n\n');
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
        currentQuestionWithUser = `${userName}: ${userMessage}`;
      } catch (error) {
        // Fallback to just the message if user name lookup fails
        currentQuestionWithUser = userMessage;
      }
    }
  }

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

IMPORTANT: First, determine if you can answer the user's question based ONLY on the provided references. Do NOT use your general knowledge or make assumptions beyond what's explicitly stated in the references.

Then respond with a JSON object containing:
1. "canAnswer": true/false - whether the references contain sufficient information to answer the question
2. "response": your answer based on the references, or a friendly explanation that you couldn't find the information

Examples of expected output:

Example 1 (can answer):
{
  "canAnswer": true,
  "response": "According to our references, you can submit a pull request by first forking the repository, making your changes, and then creating a pull request from your fork. The process is outlined in our contributing guidelines reference."
}

Example 2 (cannot answer):
{
  "canAnswer": false,
  "response": "I couldn't find specific information about deployment procedures in our current references. However, I did find some related information in our Setup Guide about initial configuration and our Development Environment reference about local testing. This seems like an important topic that would benefit from being documented! Could you ask others who might have this knowledge, or perhaps start a discussion about creating deployment documentation?"
}

Guidelines for answering:
- Be friendly, approachable, and helpful - like a senior colleague who genuinely wants to help
- Answer ONLY based on the provided references below - do NOT add general knowledge
- If multiple references contain conflicting information, prioritize the first reference in the list
- If you cannot answer based on the references, encourage the user to ask others or start a discussion to help improve our documentation
- When you cannot fully answer a question, mention which related references you found and what information they contain
- When users mention @CHOIR, that's me! Feel free to be conversational
- Use a warm, academic tone - professional but not overly formal

==== REFERENCES ====
${context}

==== CONVERSATION HISTORY ====
${messages.map((m) => m.content).join('\n')}

==== CURRENT QUESTION ====
${currentQuestionWithUser}

Analyze whether you can answer based on the documentation and provide your response as JSON:`;

  try {
    return await createStructuredResponse<AnswerResult>(
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
        temperature: 0,
        max_tokens: 1000,
        function_name: 'answerQuestion',
        debug: true,
        schemaName: 'qa_answer',
        schemaDescription: 'Whether the documentation can answer the question and the final response text',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            canAnswer: {
              type: 'boolean',
            },
            response: {
              type: 'string',
            },
          },
          required: ['canAnswer', 'response'],
        },
      },
    );
  } catch (parseError) {
    console.warn('Failed to parse structured response from answerQuestion:', parseError);

    return {
      canAnswer: false,
      response:
        "I couldn't find this information in our current documentation. Could you help by asking others or starting a discussion about this topic?",
    };
  }
};
