import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the conversation feature; keys missing here fall back to English.
 *
 * This is the voice most people meet first — a reply in a DM or a channel — so
 * it is 해요체 throughout. Display names arrive bare, so the 님 honorific is
 * added after the placeholder here rather than baked into the caller's value.
 */
export const conversation: LocaleCatalog = {
  'conversation.usageGuide.body':
    '안녕하세요 *{userName}*님! 👋 저는 CHOIR예요. {organizationName}의 문서와 지식 관리를 도와드려요.\n\n*🔍 이렇게 사용할 수 있어요:*\n\n*💬 질문할 때:* 문서나 {organizationName}에 대해 무엇이든 물어보세요\n• 예시: "재택근무 정책이 어떻게 되나요?"\n• 예시: "코드 리뷰는 어떻게 진행하나요?"\n\n*📝 업데이트할 때:* 문서에 남겨야 할 새로운 정보를 알려 주세요\n• 예시: "새 프로젝트에는 React를 쓰기로 했어요"\n• 예시: "배포 과정에 자동 테스트가 추가됐어요"\n\n*🔧 저를 부르는 방법:*\n• *채널에서:* `@choir`로 멘션한 뒤 메시지를 남겨 주세요\n• *다이렉트 메시지:* DM을 보내 주세요. 프로필 사진을 클릭하면 저를 추가할 수 있어요.\n\n*✨ 문서 업데이트, 대화에서 지식 뽑아내기, 팀 정보 정리도 도와드릴 수 있어요.*\n\n무엇부터 해 볼까요?',

  'conversation.reply.source': '_{documentationLink}을 참고했어요_',
  'conversation.link.documentation': '{organizationName} 문서',

  'conversation.clarifyPrompt.body': '💡 *제가 메시지를 잘못 이해했다면 아래 버튼을 눌러 주세요:*',
  'conversation.clarifyPrompt.fallback': '💡 제가 메시지를 잘못 이해했다면 아래 버튼을 눌러 주세요:',
  'conversation.clarifyPrompt.question.button': '❓ 질문이었어요',
  'conversation.clarifyPrompt.updateRequest.button': '📝 업데이트 요청이었어요',

  'conversation.reclassify.question.announcement':
    '🤔 *{userName}*님이 이건 질문이었다고 알려 주셨어요. 지금 제대로 처리할게요!',
  'conversation.reclassify.question.processed':
    '✅ *메시지를 질문으로 처리했어요*\n\n📝 *원래 메시지:* "{originalMessage}"\n🔄 *처리 내용:* 문서를 찾아 답변을 만들고 있어요',
  'conversation.reclassify.question.processed.fallback': '✅ 질문으로 처리했어요',
  'conversation.reclassify.question.error': '❌ 메시지를 질문으로 처리하지 못했어요: {reason}',

  'conversation.reclassify.updateRequest.announcement':
    '📝 *{userName}*님이 이건 문서 업데이트 제안이었다고 알려 주셨어요. 지금 작업할게요!',
  'conversation.reclassify.updateRequest.processed':
    '✅ *메시지를 업데이트 요청으로 처리했어요*\n\n📝 *원래 메시지:* "{originalMessage}"\n🔄 *처리 내용:* 지식을 뽑아내 문서 업데이트를 만들고 있어요',
  'conversation.reclassify.updateRequest.processed.fallback': '✅ 업데이트 요청으로 처리했어요',
  'conversation.reclassify.updateRequest.error': '❌ 메시지를 업데이트 요청으로 처리하지 못했어요: {reason}',

  'conversation.error.generic': '죄송해요, 오류가 생겼어요. 다시 시도해 주세요.',
  'conversation.anonymousThread.reply': '💬 *{authorName}*님이 익명 질문에 답변했어요:\n\n{message}',
  'conversation.restartRecovery.fallback': '취소했어요 — 처음부터 다시 할까요?',
  'conversation.restartRecovery.newFile': '↩️ 새 파일 만들기를 취소했어요. 검토를 처음부터 다시 이어서 할까요?',
  'conversation.restartRecovery.newSection': '↩️ 새 섹션 만들기를 취소했어요. 검토를 처음부터 다시 이어서 할까요?',
};
