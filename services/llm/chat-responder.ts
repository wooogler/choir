import { detectLanguage } from 'services/common/language';
import { createChatCompletion } from './completions'; // Corrected import path
import { fallbackMessage } from './fallback-messages';

export async function respondToGeneralConversation(
  message: string,
  userName: string,
  organizationName = 'our organization',
  descOrg = '',
  URLtoGithubORWebsite = '',
  workspaceId?: string,
): Promise<string> {
  // 기본 응답 목록 또는 간단한 규칙 기반 응답
  // Korean triggers sit alongside the English ones so a Korean greeting takes the
  // same canned fast path instead of falling through to the model.
  const greetings = ['hello', 'hi', 'hey', '안녕'];
  const thanks = ['thank', '감사', '고마'];
  const lowerCaseMessage = message.toLowerCase();

  // These canned replies bypass the model, so they have to pick the language themselves.
  const lang = detectLanguage(message);
  const vars = { userName, organizationName };

  if (greetings.some((greeting) => lowerCaseMessage.startsWith(greeting))) {
    return fallbackMessage('chat.greeting', lang, vars);
  }

  if (thanks.some((token) => lowerCaseMessage.includes(token))) {
    // thanks, thank you, 감사합니다, 고마워요, etc.
    return fallbackMessage('chat.thanks', lang, vars);
  }

  // LLM을 사용한 보다 동적인 응답
  try {
    const result = await createChatCompletion(
      [
        {
          role: 'system',
          content: `You are CHOIR, a friendly documentation assistant for ${organizationName}. You help the team find and manage institutional knowledge.

- Reply in the SAME language as the user, in a warm, concise tone. Keep it to 1-2 sentences. Address the user as *${userName}*.
- If the user says something off-topic (chit-chat, recommendations, jokes, trivia, personal questions), do NOT actually fulfill the request. Briefly and kindly acknowledge it, then steer back to helping with ${organizationName}'s documentation or knowledge.${URLtoGithubORWebsite ? `\n- If relevant, point users to the knowledge repository at ${URLtoGithubORWebsite}.` : ''}

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

    return result || fallbackMessage('chat.offTopic', lang, vars);
  } catch (error) {
    console.error('[ChatResponder] Error in respondToGeneralConversation:', error);
    return fallbackMessage('chat.error', lang, vars);
  }
}
