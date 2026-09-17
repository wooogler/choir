import { type LanguageCode, detectLanguage } from 'services/common/language';

/**
 * User-facing strings CHOIR returns when an LLM call fails or is skipped.
 *
 * These used to be hardcoded English, so a Korean asker got an English answer
 * the moment a model call failed. Each entry keeps its English text exactly as
 * it was and adds a Korean translation; languages without an entry fall back to
 * English. Placeholders are `{name}` and are substituted from `vars`.
 */
export type FallbackKey =
  | 'qa.noAnswer'
  | 'chat.greeting'
  | 'chat.thanks'
  | 'chat.offTopic'
  | 'chat.error'
  | 'doc.newDocumentTitle'
  | 'doc.newSectionTitle';

type MessageTable = { en: string } & Partial<Record<LanguageCode, string>>;

const MESSAGES: Record<FallbackKey, MessageTable> = {
  'qa.noAnswer': {
    en: "I couldn't find this information in our current documentation. Could you help by asking others or starting a discussion about this topic?",
    ko: '현재 문서에서는 이 정보를 찾지 못했어요. 다른 팀원에게 물어보시거나 이 주제에 대해 논의를 시작해 보시겠어요?',
  },
  'chat.greeting': {
    en: "Hi *{userName}*! 👋 I'm CHOIR, your friendly documentation assistant. Is there a specific document you're looking for about {organizationName}, or perhaps some information you'd like to update or add?",
    ko: '안녕하세요, *{userName}*님! 👋 저는 문서 도우미 CHOIR예요. {organizationName} 관련해서 찾고 계신 문서가 있나요? 아니면 업데이트하거나 추가하고 싶은 내용이 있으신가요?',
  },
  'chat.thanks': {
    en: "You're very welcome, *{userName}*! 😊 Is there anything else I can help you find or update in our {organizationName} documents today?",
    ko: '천만에요, *{userName}*님! 😊 오늘 {organizationName} 문서에서 더 찾아드리거나 업데이트할 내용이 있을까요?',
  },
  'chat.offTopic': {
    en: "That's interesting, *{userName}*! Is there anything specific about {organizationName} documents I can help you with, or perhaps an update you'd like to suggest?",
    ko: '흥미롭네요, *{userName}*님! {organizationName} 문서와 관련해 도와드릴 일이 있거나, 제안하고 싶은 업데이트가 있으신가요?',
  },
  'chat.error': {
    en: "I'm not sure how to respond to that, *{userName}*, but I'm here to help with any questions about {organizationName} documents or if you have updates to suggest!",
    ko: '어떻게 답해야 할지 잘 모르겠어요, *{userName}*님. 대신 {organizationName} 문서에 대한 질문이나 업데이트 제안은 언제든 도와드릴게요!',
  },
  'doc.newDocumentTitle': {
    en: 'New Document',
    ko: '새 문서',
  },
  'doc.newSectionTitle': {
    en: 'New Section',
    ko: '새 섹션',
  },
};

/** Returns the fallback string for `key` in `language`, falling back to English. */
export function fallbackMessage(key: FallbackKey, language: LanguageCode, vars: Record<string, string> = {}): string {
  const table = MESSAGES[key];
  const template = table[language] ?? table.en;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}

/** Convenience: detect the language of `text` and return the matching fallback. */
export function fallbackMessageFor(
  key: FallbackKey,
  text: string | null | undefined,
  vars: Record<string, string> = {},
): string {
  return fallbackMessage(key, detectLanguage(text), vars);
}
