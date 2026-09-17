import type { LocaleCatalog } from '../../types';

/**
 * Korean for the Google Docs cards.
 *
 * These land in a manager's DM while they are doing something else, so each one
 * leads with the document and ends with what is (or is not) going to happen —
 * 해요체, like the rest of the bot. "사본" is the replica, the word the viewer
 * already uses for the same thing.
 *
 * `gdocs.card.retired.*` is deliberately in the past tense: by the time a
 * manager reads one, the decision has already been taken by somebody else.
 */
export const gdocs: LocaleCatalog = {
  'gdocs.card.button.openDoc': 'Google 문서 열기',

  'gdocs.card.drift.headline': '✏️ *{file}* 문서가 Google Docs에서 편집됐어요.',
  'gdocs.card.drift.editedBy': '{editor} 님이 마지막으로 편집했어요.',
  'gdocs.card.drift.editorUnknown': '편집한 사람을 확인할 수 없어요.',
  'gdocs.card.drift.held': '이 문제가 정리될 때까지는 사본을 덮어쓰지 않아요.',
  'gdocs.card.drift.alsoOnGithub': '사본을 발행한 뒤로 GitHub 쪽도 바뀌었어요.',
  'gdocs.card.drift.button.review': '변경 검토하기',
  'gdocs.card.drift.fallback': '{path} 문서가 Google Docs에서 편집됐어요.',

  'gdocs.card.manual.headline':
    '📝 저장소에서 *{file}* 문서가 바뀌었는데, 이 Google 문서는 자체 서식을 유지하는 문서라 변경을 직접 문서에 옮겨 적어야 해요.',
  'gdocs.card.manual.note': 'CHOIR는 이 문서에 쓰지 않아서, 누군가 직접 반영하기 전까지는 아무 일도 일어나지 않아요.',
  'gdocs.card.manual.diffTruncated': { other: '… {count}자는 더 보여 주지 않았어요' },
  'gdocs.card.manual.button.applied': '반영했어요',
  'gdocs.card.manual.button.declined': '문서는 그대로 둘게요',
  'gdocs.card.manual.fallback': '저장소에서 {path} 문서가 바뀌어서 Google Docs에 반영해야 해요.',

  'gdocs.manual.reply.applied': '✅ {path} — 고마워요. 이제 문서와 저장소 내용이 같아요.',
  'gdocs.manual.reply.stillDiffers':
    '⚠️ {path} — Google 문서가 아직 저장소와 달라요. 변경을 반영한 뒤 버튼을 다시 눌러 주세요.',
  'gdocs.manual.reply.alreadyHandled': 'ℹ️ 이미 처리된 건이에요.',
  'gdocs.manual.reply.checkFailed':
    '⚠️ {path} — Google 문서를 확인하지 못했어요({outcome}). 잠시 후 다시 시도해 주세요.',
  'gdocs.manual.reply.declined':
    '↩️ {path} — 그대로 두기로 했어요. 누군가 한쪽을 바꿀 때까지 문서와 저장소는 다를 거예요.',

  'gdocs.card.retired.applied': '✅ {path} — {manager} 님이 Google Docs에 반영했어요.',
  'gdocs.card.retired.declined':
    '↩️ {path} — {manager} 님이 Google 문서를 그대로 두기로 했어요. 저장소에는 변경이 그대로 남아요.',
  'gdocs.card.retired.deletedReview': '이 문서가 삭제돼서 대기 중이던 편집은 버렸어요.',
  'gdocs.card.retired.deletedManual': '이 문서가 삭제돼서 Google Docs에 반영할 내용이 남아 있지 않아요.',
  'gdocs.card.retired.unlinkedReview': '이 문서는 더 이상 Google Docs와 동기화되지 않아서 대기 중이던 편집은 버렸어요.',
  'gdocs.card.retired.unlinkedManual':
    '이 문서는 더 이상 Google Docs와 동기화되지 않아서 반영할 내용이 남아 있지 않아요.',
  'gdocs.card.retired.republishedReview': '매니저가 이 문서를 GitHub에서 다시 발행해서 대기 중이던 편집은 버렸어요.',
  'gdocs.card.retired.rebaselinedManual': '매니저가 이 문서의 기준을 다시 잡아서, 이 요청은 더 이상 맞지 않아요.',
  'gdocs.card.retired.disconnectedReview':
    '워크스페이스의 Google 계정 연결이 끊겨서 이 편집은 더 이상 반영할 수 없어요.',
  'gdocs.card.retired.disconnectedManual':
    '워크스페이스의 Google 계정 연결이 끊겨서 이 문서들은 더 이상 동기화되지 않아요.',
};
