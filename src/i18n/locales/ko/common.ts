/**
 * Korean shared strings, in the 해요체 register CHOIR uses everywhere in Slack:
 * polite but not stiff, the same voice the bot answers questions in.
 *
 * Buttons stay nominal (취소, 확인) because that is what Slack's own Korean UI
 * does; full sentences carry the 해요 ending. Counted nouns put the number
 * before the counter word (매니저 3명), which is why the plural form is not a
 * literal translation of the English word order.
 */

export const common = {
  'common.button.cancel': '취소',
  'common.button.confirm': '확인',
  'common.button.close': '닫기',
  'common.button.submit': '제출',
  'common.button.back': '뒤로',
  'common.error.generic': '문제가 생겼어요. 다시 시도해 주세요.',
  'common.error.managerOnly': '매니저만 할 수 있어요.',
  'common.managers': '매니저들',
  'common.count.managers': { other: '매니저 {count}명' },
  'common.count.files': { other: '파일 {count}개' },
  'common.count.messages': { other: '메시지 {count}개' },
} as const;
