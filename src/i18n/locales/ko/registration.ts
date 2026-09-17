import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the registration feature; keys missing here fall back to English.
 *
 * Buttons stay nominal (승인, 거절) to match Slack's own Korean UI; the card's
 * sentences carry the 해요 ending.
 */
export const registration: LocaleCatalog = {
  'registration.managerCard.request': '🙋 *{userName}*님이 CHOIR 사용 권한을 요청했어요.',
  'registration.managerCard.request.fallback': '{userName}님이 CHOIR 사용 권한을 요청했어요.',
  'registration.managerCard.origin.channel': '{channelLink}에서 물어봤어요.',
  'registration.managerCard.origin.dm': '다이렉트 메시지로 물어봤어요.',
  'registration.managerCard.consentReminder': '참고: {consentFormLink} 작성을 마쳤는지 확인해 주세요.',
  'registration.link.consentForm': '동의서',
  'registration.managerCard.approve.button': '✅ 승인',
  'registration.managerCard.decline.button': '거절',
  'registration.managerCard.approved': '✅ *{targetName}*님 — *{managerName}*님이 승인했어요.',
  'registration.managerCard.declined': '🚫 *{targetName}*님 — *{managerName}*님이 거절했어요.',

  'registration.request.alreadyPending': '⏳ 요청이 이미 매니저 승인을 기다리고 있어요.',
  'registration.request.expired': '권한을 요청하려면 질문을 다시 보내 주세요.',
  'registration.request.noManagers': '⚠️ 이 워크스페이스에는 아직 매니저가 없어요. Slack 관리자에게 문의해 주세요.',
  'registration.request.managersUnreachable': '⚠️ 지금은 매니저에게 연락할 수 없었어요 — 잠시 후 다시 물어봐 주세요.',
  'registration.request.sent': '✅ {managers}님께 요청을 보냈어요. 승인되면 질문에 바로 답해 드릴게요.',

  'registration.action.alreadyHandled': 'ℹ️ 이미 처리된 요청이에요.',
  'registration.action.claimedByOther': 'ℹ️ 방금 다른 매니저가 이 요청을 처리했어요.',

  'registration.approve.confirmation': '✅ 이제 *{targetName}*님도 CHOIR 사용자예요.',
  'registration.approve.welcome':
    '🎉 이제 사용할 수 있어요! 팀 문서에 대해 무엇이든 물어보세요. 언제든 질문을 보내 주시면 돼요.',
  'registration.approve.welcome.withQuestion':
    '🎉 이제 사용할 수 있어요! 팀 문서에 대해 무엇이든 물어보세요.\n\n아까 남기신 질문의 답변이에요:',
  'registration.approve.originChannelHint': '원래 {channelLink}에서 물어보셨죠 — 답변을 그곳에 공유하셔도 좋아요.',

  'registration.decline.confirmation': '🚫 *{targetName}*님의 권한 요청을 거절했어요.',
  'registration.decline.notice':
    'CHOIR 사용 권한 요청이 이번에는 승인되지 않았어요. 착오라고 생각되시면 워크스페이스 매니저에게 직접 문의해 주세요.',

  'registration.nonUser.fresh':
    '안녕하세요! 👋 저는 팀 문서 도우미 CHOIR예요. 아직 CHOIR 사용자가 아니시네요 — 아래 버튼을 누르면 워크스페이스 매니저가 클릭 한 번으로 승인해 줄 수 있어요.',
  'registration.nonUser.fresh.privacy':
    '승인되면 방금 하신 질문에 바로 답해 드릴게요. 그전까지는 비공개로 남아 있고, 처리하거나 저장하지 않아요.',
  'registration.nonUser.fresh.consent': '매니저가 동의서 작성을 요청할 수 있어요: {consentFormLink}.',
  'registration.link.consentFormHere': '여기',
  'registration.nonUser.pending':
    '⏳ 권한 요청이 매니저 승인을 기다리고 있어요. 사용할 수 있게 되면 바로 알려 드릴게요!',
  'registration.nonUser.declined':
    '이전 권한 요청이 승인되지 않았어요. 착오라고 생각되시면 워크스페이스 매니저에게 직접 문의해 주세요.',
  'registration.nonUser.request.button': '🙋 권한 요청하기',
};
