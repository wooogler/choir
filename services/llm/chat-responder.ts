import { createChatCompletion } from "./completions"; // Corrected import path

export async function respondToGeneralConversation(message: string, userName: string): Promise<string> {
  // 기본 응답 목록 또는 간단한 규칙 기반 응답
  const greetings = ["hello", "hi", "hey"];
  const lowerCaseMessage = message.toLowerCase();

  if (greetings.some(greeting => lowerCaseMessage.startsWith(greeting))) {
    return `Hi *${userName}*! 👋 I'm CHOIR, your friendly documentation assistant. Is there a specific document you're looking for, or perhaps some information you'd like to update or add?`;
  }

  if (lowerCaseMessage.includes("thank")) { // thanks, thank you, etc.
    return `You're very welcome, *${userName}*! 😊 Is there anything else I can help you find or update in our documents today?`;
  }

  // LLM을 사용한 보다 동적인 응답
  try {
    const result = await createChatCompletion([
      {
        role: "system",
        content: `You are CHOIR, a friendly and helpful AI documentation assistant. Your goal is to assist users with their documentation needs. 
        When a user makes a general statement or asks something not directly related to finding or updating documents, engage politely and try to steer the conversation back to documentation. 
        Encourage them to ask questions about documents or suggest updates.
        Keep your responses concise and friendly. Address the user by their name: *${userName}*.
        Examples:
        - If user says "How are you?", you could say: "I'm doing great, *${userName}*! Ready to help you with any document questions or updates. What can I do for you today?"
        - If user says "This is cool", you could say: "I'm glad you think so, *${userName}*! Let me know if you have any specific documents you need help with, or if you have any information you'd like to add or update."
        - If user says "Tell me a joke", you could say: "I'm better at finding documents than telling jokes, *${userName}*! 😄 But if you have a question about our documentation, I'm all ears! Or perhaps there's something you'd like to add or update?"`
      },
      {
        role: "user",
        content: message
      }
    ], {
      temperature: 0.7,
      max_tokens: 150,
      function_name: "respondToGeneralConversation",
    });

    return result || `That's interesting, *${userName}*! Is there anything specific about our documents I can help you with, or perhaps an update you'd like to suggest?`;

  } catch (error) {
    console.error("[ChatResponder] Error in respondToGeneralConversation:", error);
    return `I'm not sure how to respond to that, *${userName}*, but I'm here to help with any questions about our documents or if you have updates to suggest!`;
  }
} 