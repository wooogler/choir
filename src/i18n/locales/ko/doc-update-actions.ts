import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the document-update write path; keys missing here fall
 * back to English.
 *
 * 해요체 throughout, and names take the 님 honorific at the placeholder. Two
 * choices are worth recording. `docUpdate.apply.links` reads as a colon and a
 * list rather than a translated English sentence, because Korean cannot put a
 * verb between two link labels without mangling one of them. And
 * `docUpdate.apply.cancel.notice.*` already ends in 해요, so the sentence that
 * embeds it (`cancel.channel`) contributes only the final period.
 */
export const docUpdateActions: LocaleCatalog = {
  'docUpdate.actions.editLink.selectFirst': '⚠️ 먼저 목록에서 파일을 골라 주세요.',
  'docUpdate.actions.editLink.title': '편집 링크를 보냈어요',
  'docUpdate.actions.editLink.sent': 'GitHub 편집 링크를 DM으로 보내 드렸어요.',
  'docUpdate.actions.editLink.dm.fallback': '🔗 *{fileName} GitHub 편집 링크*',
  'docUpdate.actions.editLink.dm.body':
    '🔗 *GitHub 편집 링크*\n\n📁 *파일:* {fileName}\n🌐 *링크:* {editLink}\n\n💡 *팁:* 위 링크를 누르면 GitHub에서 파일을 바로 편집할 수 있어요.',
  'docUpdate.actions.editLink.label.open': 'GitHub에서 열기',
  'docUpdate.actions.editLink.error': '❌ 편집 링크를 만들지 못했어요: {reason}',

  'docUpdate.actions.analyzed.title': '분석한 메시지',
  'docUpdate.actions.analyzed.summary': '📊 *분석 요약*\n• 세션 ID: `{sessionId}`\n• 전체 메시지: {messageCount}',
  'docUpdate.actions.analyzed.listHeading': '*📝 지식 추출에 사용한 메시지:*',
  'docUpdate.actions.analyzed.item': '*{number}. {username}*\n{text}{ellipsis}',
  'docUpdate.actions.analyzed.unknownUser': '알 수 없는 사용자',
  'docUpdate.actions.analyzed.noText': '내용 없음',
  'docUpdate.actions.analyzed.error': '❌ 분석한 메시지를 보여 드리지 못했어요: {reason}',

  'docUpdate.actions.createFile.selected': '📄 *선택: 새 파일 만들기*',
  'docUpdate.actions.createFile.selected.fallback': '📄 선택: 새 파일 만들기',
  'docUpdate.actions.createFile.title': '새 파일 만들기',
  'docUpdate.actions.createFile.submit': '파일 만들기',
  'docUpdate.actions.createFile.intro':
    '📄 *저장소에 새 마크다운 파일을 만들어요*\n\nGitHub 저장소에 새 .md 파일을 만들고, 문서 업데이트에 바로 쓸 수 있게 해 드릴게요.',
  'docUpdate.actions.createFile.name.label': '파일 이름 (.md로 끝나야 해요)',
  'docUpdate.actions.createFile.name.placeholder': '예: new-documentation.md',
  'docUpdate.actions.createFile.content.label': '초기 내용 (마크다운)',
  'docUpdate.actions.createFile.content.placeholder': '# 새 문서\n\n여기에 초기 내용을 적어 주세요...',
  'docUpdate.actions.createFile.expired':
    '⏳ 이 파일 만들기 양식은 만료됐어요. 문서 업데이트 과정에서 다시 시작해 주세요.',
  'docUpdate.actions.createFile.error.nameRequired': '파일 이름을 입력해 주세요',
  'docUpdate.actions.createFile.error.contentRequired': '파일 내용을 입력해 주세요',
  'docUpdate.actions.createFile.error.extension': '파일 이름은 .md로 끝나야 해요',
  'docUpdate.actions.createFile.error.invalidName':
    '파일 이름에 쓸 수 없는 문자가 있어요. 영문자, 숫자, 점, 하이픈, 밑줄만 써 주세요.',
  'docUpdate.actions.createFile.creating':
    '📄 *새 파일을 만들고 있어요: {fileName}*\nGitHub 저장소에 파일을 만드는 동안 잠시만 기다려 주세요...',
  'docUpdate.actions.createFile.creating.fallback': '📄 새 파일을 만들고 있어요...',
  'docUpdate.actions.createFile.failed.fallback': '❌ 파일을 만들지 못했어요',
  'docUpdate.actions.createFile.failed.exists':
    '❌ *파일을 만들지 못했어요*\n\n저장소에 `{fileName}` 파일이 이미 있어요. 다른 이름을 골라 주세요.',
  'docUpdate.actions.createFile.failed.error':
    '❌ *파일을 만들지 못했어요*\n\n파일을 만드는 중에 문제가 생겼어요: {reason}',
  'docUpdate.actions.createFile.created': '✅ *파일을 만들었어요!*\n\n📄 {fileLink} 파일을 GitHub 저장소에 만들었어요.',
  'docUpdate.actions.createFile.created.fallback': '✅ 파일을 만들었어요!',
  'docUpdate.actions.createFile.initialContent': '*초기 내용:*\n```{content}```',
  'docUpdate.actions.createFile.done':
    '🎉 *문서 업데이트를 마쳤어요!*\n새 파일을 만들었고 바로 사용할 수 있어요. 새로운 내용이 생기면 언제든 저를 불러 주세요. 문서를 함께 검토하고 업데이트할게요!',
  'docUpdate.actions.createFile.channelNotice': '📄 {createdBy}님이 새 파일을 만들었어요: {fileLink}',

  'docUpdate.actions.newSection.notEnoughInfo':
    'ℹ️ 새 섹션을 쓰기에는 정보가 조금 부족해요. 내용을 조금만 더 알려 주세요.',
  'docUpdate.actions.newSection.noWritableFiles':
    '❌ 새 섹션을 추가할 수 있는 파일이 없어요. 모든 파일이 읽기 전용으로 설정되어 있어요.',
  'docUpdate.actions.newSection.title': '새 섹션 만들기',
  'docUpdate.actions.newSection.intro':
    '👋 문서에 넣을 새 섹션을 준비했어요. 아래 내용을 확인하고 편집한 다음 *제출*을 누르면 선택하신 파일에 자동으로 추가해 드릴게요.\n\n',
  'docUpdate.actions.newSection.file.label': '추가할 파일 선택',
  'docUpdate.actions.newSection.file.placeholder': '파일을 골라 주세요...',
  'docUpdate.actions.newSection.prepared': '*🎯 준비한 섹션은 이래요:*',
  'docUpdate.actions.newSection.sectionTitle.label': '섹션 제목',
  'docUpdate.actions.newSection.sectionTitle.placeholder': '섹션 제목을 입력해 주세요...',
  'docUpdate.actions.newSection.body.label': '섹션 내용',
  'docUpdate.actions.newSection.body.placeholder': '섹션 내용을 입력해 주세요...',
  'docUpdate.actions.newSection.manualEdit': '📝 *선택한 파일을 GitHub에서 직접 편집할 수도 있어요:*',
  'docUpdate.actions.newSection.button.getEditLink': '🔗 편집 링크 받기',
  'docUpdate.actions.newSection.error.open': '❌ 새 섹션 모달을 열지 못했어요: {reason}',

  'docUpdate.apply.error.noUpdates': '문서 업데이트를 찾지 못했어요. 먼저 업데이트를 제안해 주세요.',
  'docUpdate.apply.applying': '⚙️ GitHub에 변경 사항을 반영하고 있어요...',
  'docUpdate.apply.result.default': '문서 업데이트 처리를 마쳤어요!',
  'docUpdate.apply.result.success': '✅ 좋은 소식이에요! 문서를 업데이트했어요: {fileLink}',
  'docUpdate.apply.links': '\n\n📝 GitHub에서 바로 확인해 보세요: {links}',
  'docUpdate.apply.links.pair': '{viewLink} 또는 {editLink}',
  'docUpdate.apply.link.viewChanges': '변경 사항 보기',
  'docUpdate.apply.link.editFile': '파일 편집하기',
  'docUpdate.apply.result.partialFailure':
    '\n그런데 *{fileName}* 파일을 업데이트하는 데는 문제가 조금 있었어요. 그 파일은 직접 확인해 보시는 게 좋겠어요.',
  'docUpdate.apply.result.failure':
    '음, *{fileName}* 파일은 업데이트하지 못했어요. 😕 어떤 문제가 있었는지 한번 살펴봐 주시겠어요?',
  'docUpdate.apply.result.fallback': '문서 업데이트를 마쳤어요! 문제가 있었다면 위에 적어 두었어요.',
  'docUpdate.apply.error.github':
    '😥 이런! GitHub에서 문서를 업데이트하는 중에 문제가 생겼어요. \n오류: {reason}\n\n내용을 확인하시고 다시 시도해 주시겠어요? 계속 문제가 생기면 관리자에게 문의해 주세요.',

  'docUpdate.apply.channel.updated':
    '🎉 좋은 소식이에요, 여러분! *{userName}*님이 문서 업데이트를 도와주셨어요!\n\n*파일:* {fileLink}\n*섹션:* {sectionInfo}\n\n최신 내용을 반영했어요. 함께하니 더 좋네요! ✨',
  'docUpdate.apply.button.viewChanges': '변경 사항 보기',
  'docUpdate.apply.button.viewFile': '파일 보기',

  'docUpdate.apply.newSection.error.missingFields': '❌ 섹션 제목과 내용을 모두 입력해 주세요.',
  'docUpdate.apply.newSection.error.noTargetFile': '❌ 대상 파일을 찾지 못했어요. 다시 시도해 주세요.',
  'docUpdate.apply.newSection.error.vectorStore': '❌ 벡터 스토어에 새 섹션을 추가하지 못했어요. 파일: {fileName}',
  'docUpdate.apply.newSection.error.fileNotFound': '❌ 업데이트된 마크다운 파일을 찾지 못했어요: {fileName}',
  'docUpdate.apply.newSection.error.invalidUrl': '❌ 올바르지 않은 GitHub URL이에요: {githubUrl}',
  'docUpdate.apply.newSection.error.submit': '❌ 새 섹션 제출을 처리하지 못했어요: {reason}',
  'docUpdate.apply.newSection.success':
    '✅ 새 섹션 "{sectionTitle}"을(를) GitHub에 추가했어요!\n\n📁 *파일:* {fileLink}\n📝 *추가한 사람:* {userName}',
  'docUpdate.apply.newSection.preview': '\n\n🔍 *미리 보기:*\n```# {sectionTitle}\n{sectionBody}```',
  'docUpdate.apply.newSection.channel':
    '🎉 좋은 소식이에요, 여러분! *{userName}*님이 문서에 새 섹션을 추가했어요!\n\n📁 *파일:* {fileLink}\n📝 *섹션:* {sectionTitle}\n\n새로운 내용을 담았어요. 지식이 쑥쑥 자라네요! ✨',
  'docUpdate.apply.newSection.channel.preview': '🔍 *새 섹션 미리 보기:*\n```# {sectionTitle}\n{sectionBody}```',
  'docUpdate.apply.newSection.channel.fallback':
    '✅ 새 섹션 추가: {fileName}에 {sectionTitle} (작성 *{userName}*, CHOIR와 함께)',

  'docUpdate.apply.cancel.cancelled': '👋 검토를 취소했어요',
  'docUpdate.apply.cancel.stopped': { other: '✅ 검토를 중단했어요! 제안 {count}개를 문서에 반영했어요.' },
  'docUpdate.apply.cancel.notice.cancelled': '문서 업데이트 검토를 취소했어요',
  'docUpdate.apply.cancel.notice.stopped': { other: '제안 {count}개를 반영한 뒤 문서 업데이트 검토를 중단했어요' },
  'docUpdate.apply.cancel.channel': '📋 *{userName}*님이 {notice}.',
  'docUpdate.apply.cancel.error.fallback': '❌ 문서 업데이트를 취소하지 못했어요: {reason}',
  'docUpdate.apply.cancel.error': '❌ *취소하는 중에 문제가 생겼어요*\n{reason}',
};
