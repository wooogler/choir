import type { LocaleCatalog } from '../../types';

// Korean overlay for the app-home feature; keys missing here fall back to English.
//
// The two language names (`option.english`, `option.korean`) are deliberately
// absent: a language is listed under its own name in every locale, so the
// English catalog is already correct Korean.
export const appHome: LocaleCatalog = {
  'appHome.language.title': '언어',

  'appHome.language.mine.label': '*내 언어*\nCHOIR가 나에게 말할 때 쓰는 언어예요.',
  'appHome.language.mine.placeholder': '언어 선택',

  'appHome.language.workspace.label': '*워크스페이스 언어*',
  'appHome.language.workspace.context': '멤버가 따로 설정하지 않았을 때 CHOIR의 메시지와 버튼에 쓰는 기본 언어예요',
  'appHome.language.workspace.placeholder': '언어 선택',

  'appHome.language.content.label': '*문서 작성 언어*',
  'appHome.language.content.context':
    "CHOIR가 새 문서 내용을 쓸 때 사용하는 언어예요. '대화 언어를 따라가요'를 고르면 지금과 똑같이 동작해요",
  'appHome.language.content.placeholder': '언어 선택',

  'appHome.language.option.auto': '자동 (Slack 언어를 따라가요)',
  'appHome.language.option.followConversation': '대화 언어를 따라가요',

  'appHome.language.confirm.mine': '✅ 언어를 {language}로 설정했어요.',
  'appHome.language.confirm.mineAuto': '✅ 언어를 자동으로 설정했어요. CHOIR가 {language}로 말할게요.',
  'appHome.language.confirm.workspace': '✅ 워크스페이스 언어를 {language}로 설정했어요.',
  'appHome.language.confirm.content': '✅ 문서 작성 언어를 {language}로 설정했어요.',
};
