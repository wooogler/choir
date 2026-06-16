import { createChatCompletion } from './completions'; // Corrected import path

export async function respondToGeneralConversation(
  message: string,
  userName: string,
  organizationName = 'our organization',
  descOrg = '',
  URLtoGithubORWebsite = '',
  workspaceId?: string,
): Promise<string> {
  // 기본 응답 목록 또는 간단한 규칙 기반 응답
  const greetings = ['hello', 'hi', 'hey'];
  const lowerCaseMessage = message.toLowerCase();

  if (greetings.some((greeting) => lowerCaseMessage.startsWith(greeting))) {
    return `Hi *${userName}*! 👋 I'm CHOIR, your friendly documentation assistant. Is there a specific document you're looking for about ${organizationName}, or perhaps some information you'd like to update or add?`;
  }

  if (lowerCaseMessage.includes('thank')) {
    // thanks, thank you, etc.
    return `You're very welcome, *${userName}*! 😊 Is there anything else I can help you find or update in our ${organizationName} documents today?`;
  }

  // LLM을 사용한 보다 동적인 응답
  try {
    const result = await createChatCompletion(
      [
        {
          role: 'system',
          content: `You are CHOIR, a friendly and helpful AI documentation assistant for ${organizationName}. Your goal is to help users manage institutional knowledge of the organization.
When a user makes a general statement or asks something not directly related to finding or updating documents, engage politely and steer the conversation back to documentation needs.
Keep your responses concise and friendly. Address the user by their name: *${userName}*.${URLtoGithubORWebsite ? `\nIf relevant, point users to the knowledge repository at ${URLtoGithubORWebsite}.` : ''}

Example responses:
- "How are you?" → "I'm doing great, *${userName}*! Ready to answer any questions about ${organizationName}. What can I help with?"
- "Tell me a joke" → "I'm better at finding documents than telling jokes, *${userName}*! 😄 Got any questions about our documentation?"

Organization: ${organizationName}${descOrg ? `\nAbout: ${descOrg}` : ''}`,
        },
        {
          role: 'user',
          content: message,
        },
      ],
      {
        workspaceId,
        purpose: 'qa',
        temperature: 0,
        max_tokens: 150,
        function_name: 'respondToGeneralConversation',
      },
    );

    return (
      result ||
      `That's interesting, *${userName}*! Is there anything specific about ${organizationName} documents I can help you with, or perhaps an update you'd like to suggest?`
    );
  } catch (error) {
    console.error('[ChatResponder] Error in respondToGeneralConversation:', error);
    return `I'm not sure how to respond to that, *${userName}*, but I'm here to help with any questions about ${organizationName} documents or if you have updates to suggest!`;
  }
}
