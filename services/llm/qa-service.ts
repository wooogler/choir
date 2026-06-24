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
          content: `You are CHOIR, a helpful documentation assistant. Answer questions using ONLY the provided references.

Rules:
- Use only what the references explicitly state. Do not use outside knowledge or guess.
- Answer in the same language as the question. Be concise and direct.
- Answer naturally and state the facts directly. Do NOT gratuitously cite or name the references (avoid "According to the X policy" / "참고자료에 따르면") when there is a single clear answer.
- If the references conflict on the answer, you MUST point out the conflict: state what each version says (e.g. "older documentation says 3 days, but a more recent update says 2 days"), then give your recommended answer, preferring the most recent or explicitly updated version. Never mention internal ranking rules.
- If the references do not contain the answer, set canAnswer to false, say what related information you did find, and suggest asking the team or starting a discussion.
- "@CHOIR" refers to you. Use a warm, professional tone.`,
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
