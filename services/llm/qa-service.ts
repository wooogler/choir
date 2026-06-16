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
  workspaceId?: string,
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

  const orgInfo = [
    organizationName ? `- Organization: ${organizationName}` : '',
    organizationDescription ? `- About: ${organizationDescription}` : '',
    `- Today's date: ${today}`,
    workspaceName ? `- Workspace: ${workspaceName}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `Organization Information:
${orgInfo}

==== REFERENCES ====
${context}

==== CONVERSATION HISTORY ====
${messages.map((m) => m.content).join('\n')}

==== CURRENT QUESTION ====
${currentQuestionWithUser}`;

  try {
    return await createStructuredResponse<AnswerResult>(
      [
        {
          role: 'system',
          content: `You are CHOIR, a helpful and approachable documentation assistant. You answer questions based ONLY on the provided references.

Rules:
- Do NOT use general knowledge or make assumptions beyond what's explicitly stated in the references
- If multiple references contain conflicting information, prioritize the first reference in the list
- If you cannot answer, mention which related references you found and encourage the user to ask others or start a discussion
- When users mention @CHOIR, that refers to you
- Use a warm, academic tone — professional but not overly formal`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        workspaceId,
        purpose: 'qa',
        temperature: 0,
        max_tokens: 1000,
        function_name: 'answerQuestion',
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
