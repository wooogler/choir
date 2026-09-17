import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the notifications feature; keys missing here fall back to English.
 *
 * These are read by a manager in their DMs, so they stay in 해요체 like the rest
 * of CHOIR's Slack voice. Names arrive as bare display names, so the Korean adds
 * the 님 honorific at the call site's placeholder rather than asking the caller
 * to bake it in.
 */
export const notifications: LocaleCatalog = {
  'notifications.link.viewRepository': '저장소 보기',
  'notifications.link.viewDiscussion': '원래 대화 보기',

  'notifications.webhook.started': '🔄 문서 변경 사항을 반영하고 있어요...',
  'notifications.webhook.noDocuments': '❌ 변경 사항을 반영할 수 없어요: 문서를 찾지 못했어요.',
  'notifications.webhook.noDocuments.detail': '❌ 변경 사항을 반영할 수 없어요: 문서를 찾지 못했어요. {repositoryLink}',
  // Korean has one cardinal form, so the counter word carries the number.
  'notifications.webhook.succeeded': {
    other: '✅ 문서 변경 사항을 반영했어요! 파일 {count}개를 업데이트했어요. {link}',
  },
  'notifications.webhook.processingFailed': '❌ 변경 사항을 반영할 수 없어요: 처리에 실패했어요.',
  'notifications.webhook.processingFailed.detail':
    '❌ 변경 사항을 반영할 수 없어요: 처리에 실패했어요. 홈에서 "Reload From Github"를 눌러 보거나 리서치 팀에 문의해 주세요. {repositoryLink}',
  'notifications.webhook.systemError': '❌ 문서 변경 사항을 반영할 수 없어요: 시스템 오류가 발생했어요.',
  'notifications.webhook.systemError.detail':
    '❌ 문서 변경 사항을 반영할 수 없어요: 시스템 오류가 발생했어요. 홈에서 "Reload From Github"를 눌러 보거나 리서치 팀에 문의해 주세요. {repositoryLink}',

  'notifications.manager.update.fallback': '📝 {updatedBy}님이 문서를 업데이트했어요',
  'notifications.manager.update.body':
    '📝 *문서 업데이트 알림*\n\n{updatedBy}님이 함께 검토하던 문서를 업데이트했어요.',

  'notifications.manager.suggestion.intro':
    '안녕하세요, 문서 도우미 CHOIR예요.\n*{userName}*님이 문서 업데이트를 제안했어요:',
  'notifications.manager.suggestion.anonymousUser': '팀원',
  'notifications.manager.suggestion.noContent': '내용이 없어요',
  'notifications.manager.suggestion.context': '📍 맥락은 {discussionLink}에서 확인할 수 있어요',
  'notifications.manager.suggestion.claimed': '✅ *{managerName}님이 처리를 시작했어요*',
  'notifications.manager.suggestion.claimed.fallback': '✅ {managerName}님이 처리를 시작했어요',

  'notifications.channel.processingStarted':
    '🔄 *{managerName}*님이 문서 업데이트 제안을 처리하기 시작했어요. 잠시 후 DM으로 문서 제안을 보내 드릴게요! 📝',
  'notifications.channel.processingStarted.fallback': '🔄 {managerName}님이 문서 업데이트 제안을 처리하기 시작했어요.',

  'notifications.rateLimit.notice':
    '⏳ 요청이 몰려서 조금 천천히 처리하고 있어요. {context} 요청은 처리 중이지만 평소보다 시간이 조금 더 걸릴 수 있어요. 기다려 주셔서 고마워요!',
};
