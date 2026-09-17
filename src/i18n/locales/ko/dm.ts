import type { LocaleCatalog } from '../../types';

// Korean overlay for the dm feature; keys missing here fall back to English.
export const dm: LocaleCatalog = {
  'dm.clear.noMessages': '💬 지울 메시지가 없어요.',
  'dm.clear.noChoirMessages.text': '💬 지울 CHOIR 메시지가 없어요.',
  'dm.clear.noChoirMessages':
    '💬 지울 CHOIR 메시지가 없어요.\n\n_참고: CHOIR가 보낸 메시지만 지울 수 있어요. 사용자가 보낸 메시지는 봇이 지울 수 없어요._',
  'dm.clear.confirm.text': '🗑️ 최근 CHOIR 메시지 {count}개를 지울까요?',
  'dm.clear.confirm':
    '🗑️ *최근 CHOIR 메시지 지우기*\n\n이 대화에서 CHOIR 메시지 {total}개를 찾았어요. 그중 가장 최근 {count}개를 지울게요.\n\n정말 지울까요? 이 작업은 되돌릴 수 없어요.',
  'dm.clear.confirm.button': '최근 {count}개 지우기',
  'dm.clear.error': '❌ 대화를 지우는 중에 문제가 생겼어요. 다시 시도해 주세요.',
  'dm.clear.progress.text': '🗑️ 최근 메시지를 지우고 있어요...',
  'dm.clear.progress': '🗑️ *최근 메시지 {count}개를 지우고 있어요...*\n메시지를 지우는 동안 잠시 기다려 주세요.',
  'dm.clear.failed.text': '❌ 메시지를 지우지 못했어요',
  'dm.clear.failed': '❌ *메시지를 지우지 못했어요*\n대화를 지우는 중에 문제가 생겼어요. 다시 시도해 주세요.',
};
