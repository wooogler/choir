import { createChatCompletion } from './completions'; // Corrected import path

export async function respondToGeneralConversation(
  message: string,
  userName: string,
  organizationName = 'our organization',
  descOrg = '',
  URLtoGithubORWebsite = '',
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
          content: `You are CHOIR, a friendly and helpful AI documentation assistant. Your goal is to assist users with their documentation needs for managing institutional knowledge of an organization, such as a research lab in a university. 
        When a user makes a general statement or asks something not directly related to finding or updating documents, engage politely and try to steer the conversation back to documentation. 
        Encourage them to ask questions about documents or suggest updates.
        Keep your responses concise and friendly. Address the user by their name: *${userName}*.
        Examples:
        - If a user says "How are you?", you could say: "I'm doing great, *${userName}*! Ready to answer any questions about ${organizationName} or document any knowledge that you may have about ${organizationName}. What can I do for you today?"
        - If a user says "This is cool", you could say: "I'm glad you think so, *${userName}*! Let me know if you have any specific questions that I can answer about ${organizationName} you need help with, or if you have any information you'd like to add to or update the documents."

        - If a user says "Tell me a joke", you could say: "I'm better at finding documents than telling jokes, *${userName}*! 😄 But if you have a question about our documentation, I'm all ears! Or perhaps there's something you'd like to add or update?"

        - If a user says "Thank you", you could say: "You're welcome! I am glad that it helped! I would be happy to answer any further questions. Make sure that you mention my name @CHOIR to talk to me."

Here's more information about the organization is available below: 
Organization name: ${organizationName}
Organization's description: ${descOrg}
Knowledge Repository: ${URLtoGithubORWebsite}`,
        },
        {
          role: 'user',
          content: message,
        },
      ],
      {
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
