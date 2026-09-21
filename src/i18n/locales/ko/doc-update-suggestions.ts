import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the document-update review surface; keys missing here fall
 * back to English.
 *
 * 해요체 throughout, the same voice CHOIR uses everywhere else in Slack. Three
 * things the English did not have to decide. Names take the 님 honorific at the
 * placeholder, because a bare display name reads as a label rather than a
 * person. Every `bonus.*` value keeps its leading `💡`: `message-cleanup.ts`
 * strips a stale hint by testing `startsWith('💡')`, so dropping the emoji
 * would leave the hint stuck on an answered card. And `"All Files"` stays in
 * English inside `error.noContentInFile` — it names a control Slack renders
 * from the untranslated option list.
 */
export const docUpdateSuggestions: LocaleCatalog = {
  'docUpdate.user.fallbackName': '사용자',
  'docUpdate.channel.dm': 'DM',
  'docUpdate.channel.this': '이 채널',

  'docUpdate.suggestions.card.heading': '📝 *업데이트 제안 {number}*',
  'docUpdate.suggestions.card.anchor.range': '\n기준 위치: {startLine}-{endLine}번째 줄',
  'docUpdate.suggestions.card.anchor.single': '\n기준 위치: {startLine}번째 줄',
  'docUpdate.suggestions.card.fileInfo': '파일: {fileLink}\n섹션: {sectionInfo}{anchor}',
  'docUpdate.suggestions.card.explain.changes':
    '📝 공유해 주신 내용을 바탕으로 *업데이트*할 만한 부분을 찾았어요. 어떤 내용이 바뀌거나 추가될지 그대로 보여 드릴게요.',
  'docUpdate.suggestions.card.explain.aligned':
    '✅ 좋은 소식이에요! 이 섹션은 이미 공유해 주신 내용과 잘 맞아요. 의도하신 내용이 담겨 있는지 확인하실 수 있게 현재 내용을 보여 드릴게요.',
  'docUpdate.suggestions.card.fallback': '문서 업데이트 제안',

  'docUpdate.suggestions.button.edit': '이 내용 편집',
  'docUpdate.suggestions.button.apply': '✅ 변경 사항 적용',
  'docUpdate.suggestions.button.looksGood': '✅ 좋아요',
  'docUpdate.suggestions.button.skip': '⏭️ 건너뛰기',
  'docUpdate.suggestions.button.stop': '검토 중단',
  'docUpdate.suggestions.button.newSection': '💡 새 섹션 만들기',
  'docUpdate.suggestions.button.newFile': '📄 새 파일 만들기',
  'docUpdate.suggestions.button.startOver': '🔄 처음부터 다시',
  'docUpdate.suggestions.button.editSuggestion': '✏️ 제안 편집',
  'docUpdate.suggestions.button.startProcess': '🚀 업데이트 시작',
  'docUpdate.suggestions.button.createSection': '📝 새 섹션 만들기',

  'docUpdate.suggestions.fileSwitcher.prompt': '📁 *이 파일을 업데이트하고 있어요* — 다른 파일로 바꾸려면 골라 주세요:',
  'docUpdate.suggestions.fileSwitcher.placeholder': '파일을 골라 주세요...',

  'docUpdate.suggestions.link.here': '여기',
  'docUpdate.suggestions.bonus.newSectionOrEdit':
    '💡 *다른 방법:* 이 섹션을 업데이트하는 대신 새 섹션을 만들 수도 있고, {fileName} 파일을 GitHub에서 {editLink}를 눌러 직접 편집할 수도 있어요.',
  'docUpdate.suggestions.bonus.newSectionOnly':
    '💡 *이런 방법도 있어요:* 이 섹션이 이미 잘 맞더라도, 공유해 주신 지식은 별도의 섹션으로 둘 만해요! 어디에 어떻게 새 섹션을 만들면 좋을지 제안해 드릴 수 있어요. 아래의 "새 섹션 만들기"를 눌러 보세요!',
  'docUpdate.suggestions.bonus.editOnly':
    '💡 *다른 방법:* {fileName} 문서를 GitHub에서 {editLink}를 눌러 직접 편집할 수도 있어요.',

  'docUpdate.suggestions.loading.searchingAll': '🔍 모든 파일에서 관련 문서를 찾고 있어요...',
  'docUpdate.suggestions.loading.forFile': '📝 {fileName}에 대한 제안을 만들고 있어요...',
  'docUpdate.suggestions.loading.generating': '📝 업데이트 제안을 만들고 있어요...',
  'docUpdate.suggestions.error.noKnowledge': '지식 내용을 찾을 수 없어요. 다시 시도해 주세요.',
  'docUpdate.suggestions.error.processingDocument': '❌ 문서를 처리하는 중에 문제가 생겼어요. 다음으로 넘어갈게요.',
  'docUpdate.suggestions.error.generic': '문서 업데이트를 제안하는 중에 문제가 생겼어요: {reason}',
  'docUpdate.suggestions.error.missingUpdate':
    '❌ 이 업데이트의 상세 내용을 불러올 수 없어요. 다시 시도하시거나 건너뛰어 주세요.',
  'docUpdate.suggestions.error.noContentInFile':
    '선택하신 파일 {fileName}에서 관련 내용을 찾지 못했어요. 다른 파일을 골라 보시거나 "All Files"를 선택해 주세요.',
  'docUpdate.suggestions.error.noDocuments':
    '📝 저장소에서 문서를 찾지 못했어요. 마크다운 파일이 있는 GitHub 저장소를 먼저 연결하시거나, 저장소에 마크다운 파일을 추가해 주세요.',
  'docUpdate.suggestions.error.noRelevantDocuments':
    '추출한 지식과 관련된 문서를 찾지 못했어요. 다른 내용으로 시도하시거나 관리자에게 문의해 주세요.',

  'docUpdate.suggestions.scope.widened': '_`{folder}`에서는 맞는 문서를 찾지 못해 저장소 전체에서 찾았어요._',

  'docUpdate.suggestions.empty.fallback':
    '💡 벡터 스토어에 기존 내용이 없어서, 이 지식을 담을 새 섹션을 만들어 드릴게요!',
  'docUpdate.suggestions.empty.body':
    '💡 *기존 내용이 없어요 - 새로 만들어 볼까요!*\n\n공유해 주신 지식으로 새 섹션을 준비했어요. 아래에서 확인하고 문서에 추가해 보세요.',

  'docUpdate.suggestions.skip.confirmed': '⏭️ {fileName}의 제안 {number}을(를) *건너뛰었어요*',
  'docUpdate.suggestions.skip.confirmed.fallback': '⏭️ {fileName}의 제안 {number}을(를) 건너뛰었어요',
  'docUpdate.suggestions.skip.unknownFile': '알 수 없는 파일',

  'docUpdate.suggestions.complete.prompt':
    '🎉 *검토를 마쳤어요!* 관련 문서를 모두 살펴봤어요. \n\n대신 새로운 내용을 만들어 볼까요?',
  'docUpdate.suggestions.complete.fallback': '🎉 검토를 마쳤어요! 새로운 내용을 만들어 볼까요?',
  'docUpdate.suggestions.complete.hint':
    '새로운 내용이 생기면 언제든 저를 불러 주세요. 문서를 함께 검토하고 업데이트할게요! 👋',
  'docUpdate.suggestions.complete.simple':
    '🎉 좋아요! 관련 문서를 모두 검토했어요. 문서를 최신 상태로 유지하는 데 함께해 주셔서 고마워요! \n\n나중에 더 공유하실 내용이 생기면 저를 불러 주세요. 문서를 다시 검토하고 업데이트하는 일을 기꺼이 도와 드릴게요. 좋은 하루 보내세요! 👋',

  'docUpdate.suggestions.applied.channel': '✅ {updatedBy}님이 문서를 업데이트했어요: {fileLink} - {sectionInfo}',
  'docUpdate.suggestions.applied.updatedContent': '*업데이트된 내용:*\n```{content}```',

  'docUpdate.suggestions.review.intro.own':
    '안녕하세요, 문서 도우미 CHOIR예요.\n\n회원님이 보내신 문서 업데이트 제안이 있어요:',
  'docUpdate.suggestions.review.intro.other':
    '안녕하세요, 문서 도우미 CHOIR예요.\n\n*{userName}*님이 문서 업데이트를 제안했어요:',
  'docUpdate.suggestions.review.prompt.own': '위의 제안을 확인하시고 어떻게 진행할지 골라 주세요:',
  'docUpdate.suggestions.review.prompt.other':
    '회원님이 요청하신 문서 업데이트 제안이에요. 위의 내용을 확인하시고 어떻게 진행할지 골라 주세요:',
  'docUpdate.suggestions.review.fallback': '📝 *{userName}*님이 보낸 문서 업데이트 제안',

  'docUpdate.suggestions.conflict.anotherManager': '다른 매니저',
  'docUpdate.suggestions.conflict.claimed': '❌ *{managerName}님이 이미 처리하고 있어요*',
  'docUpdate.suggestions.conflict.claimed.fallback': '❌ {managerName}님이 이미 처리하고 있어요',
  'docUpdate.suggestions.image.alt.profile': '프로필 사진',

  'docUpdate.suggestions.editor.title': '수정 제안 편집',
  'docUpdate.suggestions.editor.submit': '변경 사항 저장',
  'docUpdate.suggestions.editor.originalLabel': '*원래 내용:*',
  'docUpdate.suggestions.editor.updatedLabel': '업데이트할 내용',
  'docUpdate.suggestions.editor.emptySection': '*빈 섹션 - 내용을 새로 만들어 드릴게요*',
  'docUpdate.suggestions.editor.fallback': '문서 업데이트 제안',
  'docUpdate.suggestions.editor.error.open': '수정 편집기를 열 수 없어요: {reason}',
  'docUpdate.suggestions.editor.error.save': '변경 사항을 저장할 수 없어요: {reason}',
  'docUpdate.suggestions.preview.truncated': '_… 미리 보기를 줄였어요 ({characters}자는 표시하지 않았어요)_',
};
