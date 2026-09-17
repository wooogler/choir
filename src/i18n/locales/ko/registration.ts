import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the registration feature; keys missing here fall back to English.
 *
 * Buttons stay nominal (승인, 거절) to match Slack's own Korean UI; the card's
 * sentences carry the 해요 ending.
 */
export const registration: LocaleCatalog = {
  'registration.managerCard.request': '🙋 *{userName}*님이 CHOIR 사용 권한을 요청했어요.',
  'registration.managerCard.origin.channel': '{channelLink}에서 물어봤어요.',
  'registration.managerCard.origin.dm': '다이렉트 메시지로 물어봤어요.',
  'registration.managerCard.consentReminder': '참고: {consentFormLink} 작성을 마쳤는지 확인해 주세요.',
  'registration.link.consentForm': '동의서',
  'registration.managerCard.approve.button': '✅ 승인',
  'registration.managerCard.decline.button': '거절',
};
