import type { LocaleCatalog } from '../../types';

/**
 * Korean overlay for the knowledge-extraction surfaces; keys missing here fall
 * back to English.
 *
 * 해요체 throughout, like the rest of CHOIR's Slack voice. Names arrive as bare
 * display names, so the 님 honorific is added around the placeholder rather
 * than baked into the value the caller passes.
 *
 * Two shapes are deliberately not literal translations. Counted nouns put the
 * number after the noun (메시지 3개), and the "cancelled by …" sentence needs
 * its actor in subject position, so `reviewCancel.by.*` ends in the subject
 * marker 이/가 and slots in before the verb rather than after it.
 */
export const docUpdateExtract: LocaleCatalog = {
  'docUpdate.extract.managers.fallback': '매니저',
  'docUpdate.extract.managers.andOthers': '{name}님 외 매니저들',

  'docUpdate.extract.progress.analyzing': '🔍 최근 메시지를 분석해서 지식을 정리하고 있어요...',
  'docUpdate.extract.preview.intro': '{managerText}님께 다음 업데이트를 제안할게요.',
  'docUpdate.extract.preview.heading': '제안된 업데이트',
  'docUpdate.extract.preview.edited': '{managerText}님께 다음 업데이트를 제안할게요. *(수정됨)*',
  'docUpdate.extract.preview.edited.fallback': '{managerText}님께 다음 업데이트를 제안할게요. (수정됨)',
  'docUpdate.extract.preview.editedByManager': '{managerText}님께 다음 업데이트를 제안할게요. *(매니저가 수정함)*',
  'docUpdate.extract.preview.editedByManager.fallback':
    '{managerText}님께 다음 업데이트를 제안할게요. (매니저가 수정함)',
  'docUpdate.extract.empty': '최근 대화에서 문서로 남길 만한 내용을 찾지 못했어요.',
  'docUpdate.extract.empty.detail':
    '최근 대화에서 문서로 남길 만한 내용을 찾지 못했어요.\n\n어떤 정책, 마감일, 파일, 절차를 바꿔야 하는지 구체적으로 알려 주신 다음 다시 시도해 주세요.',

  'docUpdate.extract.actions.editHint': '필요하면 제안된 업데이트를 수정할 수 있어요.',
  'docUpdate.extract.actions.edit.button': '수정',
  'docUpdate.extract.actions.confirmHint': '준비되면 업데이트 제안을 눌러서 확정해 주세요.',
  'docUpdate.extract.actions.suggest.button': '업데이트 제안',

  'docUpdate.extract.edit.modal.title': '지식 수정',
  'docUpdate.extract.edit.modal.submit': '지식 업데이트',
  'docUpdate.extract.edit.modal.intro': '*업데이트를 적용하기 전에 추출된 지식을 수정해 주세요:* ',
  'docUpdate.extract.edit.modal.label': '지식 내용',
  'docUpdate.extract.edit.modal.placeholder': '문서로 남길 지식을 입력해 주세요...',
  'docUpdate.extract.edit.modal.source': { other: '📊 *출처:* 메시지 {count}개를 분석했어요' },

  'docUpdate.extract.managerEdit.modal.title': '제출된 지식 수정',
  'docUpdate.extract.managerEdit.modal.intro': '*사용자가 제출한 지식을 수정해 주세요:*',

  'docUpdate.extract.card.header': '📝 문서 업데이트 제안',
  'docUpdate.extract.card.header.editedByManager': '📝 문서 업데이트 제안 (매니저가 수정함)',
  'docUpdate.extract.card.fallback': '문서 업데이트 제안',
  'docUpdate.extract.card.new.fallback': '📝 *{userName}*님이 보낸 새 문서 업데이트 제안이에요. 검토해 주세요.',
  'docUpdate.extract.card.updatedByManager.fallback': '📝 매니저가 세션 {sessionId}의 문서 업데이트 제안을 수정했어요.',
  'docUpdate.extract.card.unknownUser': '알 수 없는 사용자',
  'docUpdate.extract.card.profileAlt': '프로필 사진',
  'docUpdate.extract.card.from': '*보낸 사람:* {user} (최초 요청자: {userName})',
  'docUpdate.extract.card.fromWithContent': '*보낸 사람:* {user} (최초 요청자: {userName})\n*내용:*\n```{content}```',
  'docUpdate.extract.card.fromName': '*보낸 사람:* *{userName}*',
  'docUpdate.extract.card.claimed': '✅ *{managerName}님이 처리를 시작했어요*\n~~이 제안은 이제 처리 중이에요.~~',
  'docUpdate.extract.card.editKnowledge.button': '지식 수정',
  'docUpdate.extract.card.editSuggestion.button': '✏️ 제안 수정',
  'docUpdate.extract.card.startUpdate.button': '문서 업데이트 시작',
  'docUpdate.extract.card.startProcess.button': '🚀 업데이트 진행 시작',
  'docUpdate.extract.card.dismiss.button': '무시',
  'docUpdate.extract.card.decline.button': '거절',
  'docUpdate.extract.card.knowledgeUpdated': '*지식을 업데이트했어요 (원본 메시지를 찾지 못했어요):*\n```{content}```',
  'docUpdate.extract.card.knowledgeUpdated.fallback': '지식을 업데이트했어요. 이제 문서 업데이트를 시작할 수 있어요.',

  'docUpdate.extract.sent.ephemeral': '✅ *업데이트 제안을 보냈어요!*\n매니저에게 검토를 요청했어요.',
  'docUpdate.extract.sent.ephemeral.fallback': '✅ 업데이트 제안을 보냈어요!',
  'docUpdate.extract.sent.channel': {
    other:
      '✅ *{userName}*님, 좋은 소식이에요! 문서 업데이트 제안을 매니저({managerNames})에게 잘 보냈어요. 곧 검토해 줄 거예요!',
  },
  'docUpdate.extract.sent.channel.fallback': {
    other:
      '✅ *{userName}*님, 좋은 소식이에요! 문서 업데이트 제안을 매니저({managerNames})에게 잘 보냈어요. 곧 검토해 줄 거예요! (보낸 채널: #{channelName})',
  },
  'docUpdate.extract.sent.dm': {
    other:
      '✅ 업데이트 제안을 매니저 {count}명에게 전달했어요. 매니저가 제안을 문서에 반영하거나 의견을 남길 수 있어요.',
  },

  'docUpdate.extract.conflict.anotherManager': '다른 매니저',
  'docUpdate.extract.conflict.body':
    '❌ *이미 처리 중이에요*\n\n{managerName}님이 이 제안을 처리하고 있어요. 끝날 때까지 기다려 주세요.',
  'docUpdate.extract.conflict.fallback': '❌ {managerName}님이 이미 처리하고 있어요',
  'docUpdate.extract.processing.body':
    '✅ *처리를 시작했어요!*\n🔄 문서 제안을 만들고 있어요...\n문서 제안은 DM으로 보내 드릴게요.',
  'docUpdate.extract.processing.fallback': '✅ 처리를 시작했어요!',
  'docUpdate.extract.processing.openDm.button': 'DM 열기',
  'docUpdate.extract.processing.channel': '🔄 매니저가 지식을 처리해서 문서 업데이트를 만들고 있어요...',
  'docUpdate.extract.processing.channel.fallback': '🔄 지식을 처리해서 문서 업데이트를 만들고 있어요...',

  'docUpdate.extract.cancel.ephemeral': '✅ *선택하신 내용을 처리하고 있어요...*',
  'docUpdate.extract.cancel.ephemeral.fallback': '✅ 알겠어요!',
  'docUpdate.extract.cancel.channel': '❌ 업데이트 제안을 *취소했어요*.',
  'docUpdate.extract.cancel.channel.fallback': '❌ 업데이트 제안을 취소했어요',

  'docUpdate.extract.decline.unknownManager': '매니저',
  'docUpdate.extract.decline.anonymousManager': '매니저',
  'docUpdate.extract.decline.declinedBy': '❌ *{managerName}님이 거절했어요* - 더 진행하지 않을게요.',
  'docUpdate.extract.decline.channel':
    '❌ *{userName}*님, 문서 업데이트 제안을 *{managerName}님이 거절했어요*. 지금은 문서를 바꾸지 않을게요.',
  'docUpdate.extract.decline.channel.fallback': '❌ {managerName}님이 업데이트 제안을 거절했어요',
  'docUpdate.extract.decline.otherManagers':
    '{decliningManagerName}님이 *{userName}*님의 문서 업데이트 제안을 거절했어요. 그래도 검토할 만하다고 생각하면 살펴볼 수 있어요.',

  'docUpdate.extract.reviewCancel.anonymousSuggester': '최초 제안자',
  'docUpdate.extract.reviewCancel.anonymousUser': '사용자',
  'docUpdate.extract.reviewCancel.anonymousUserShort': '사용자',
  'docUpdate.extract.reviewCancel.by.self': '*본인*(제안자)이',
  'docUpdate.extract.reviewCancel.by.other': '*{userName}*님이',
  'docUpdate.extract.reviewCancel.by.reviewer': '*{userName}*님(검토자, 최초 제안자는 *{suggesterName}*님)이',
  'docUpdate.extract.reviewCancel.channel':
    '🙅‍♀️ 알겠어요, {cancelledBy} 문서 업데이트 제안(ID: {sessionId})을 취소했어요. 당분간 추가로 진행할 일은 없어요. 마음이 바뀌면 언제든 새로 제안할 수 있어요!',
  'docUpdate.extract.reviewCancel.channel.fallback': '업데이트 제안 검토(ID: {sessionId})를 취소했어요.',
  'docUpdate.extract.reviewCancel.manager.byUser':
    '🙅‍♀️ *{userName}*님이 문서 업데이트 제안(ID: {sessionId})을 취소했어요. 이 건은 따로 하실 일이 없어요. 고마워요!',
  'docUpdate.extract.reviewCancel.manager.byReviewer':
    '🙅‍♀️ *{suggesterName}*님이 낸 문서 업데이트 제안(ID: {sessionId})을 다른 검토자 *{userName}*님이 취소했어요. 이 건은 따로 하실 일이 없어요. 고마워요!',
  'docUpdate.extract.reviewCancel.manager.bySuggester':
    '🙅‍♀️ *{suggesterName}*님이 낸 문서 업데이트 제안(ID: {sessionId})을 본인이 취소했어요. 이 건은 따로 하실 일이 없어요. 고마워요!',
  'docUpdate.extract.reviewCancel.manager.fallback': '제안 검토를 취소했어요.',
  'docUpdate.extract.reviewCancel.own.default':
    '알겠어요! 이 업데이트 제안(ID: {sessionId})을 취소했어요. 언제든 새로 제안해 주세요!',
  'docUpdate.extract.reviewCancel.own.manager':
    '알겠어요, *{suggesterName}*님의 제안(ID: {sessionId})을 취소로 표시했어요. 이 건은 따로 하실 일이 없어요.',
  'docUpdate.extract.reviewCancel.own.suggester':
    '알겠어요, *{userName}*님. 업데이트 제안(ID: {sessionId})을 취소했어요. 다른 걸 제안하고 싶으면 알려 주세요.',
  'docUpdate.extract.reviewCancel.own.other': '*{userName}*님이 업데이트 제안(ID: {sessionId})을 취소했어요.',
  'docUpdate.extract.reviewCancel.own.fallback': '업데이트 제안을 취소했어요.',

  'docUpdate.extract.error.noMessages': '❌ 분석할 메시지를 찾지 못했어요.',
  'docUpdate.extract.error.invalidSession': '❌ 세션이 올바르지 않아요. 지식 추출을 다시 시도해 주세요.',
  'docUpdate.extract.error.invalidSessionSubmit': '❌ 세션이 올바르지 않아요. 제안을 다시 보내 주세요.',
  'docUpdate.extract.error.sessionMissing': '❌ 세션 데이터를 찾지 못했어요. 지식 추출을 다시 시도해 주세요.',
  'docUpdate.extract.error.sessionMissingSubmit': '❌ 세션 데이터를 찾지 못했어요. 제안을 다시 보내 주세요.',
  'docUpdate.extract.error.sessionMissingManager':
    '❌ 세션 데이터를 찾지 못했어요. 다시 시도하거나 요청한 분에게 다시 보내 달라고 해주세요.',
  'docUpdate.extract.error.emptyContent': '❌ 진행하려면 지식 내용을 입력해 주세요.',
  'docUpdate.extract.error.noManagers': '❌ 이 워크스페이스에 매니저가 없어요. 관리자에게 문의해 주세요.',
  'docUpdate.extract.error.extractionFailed': '❌ 메시지에서 지식을 추출하지 못했어요: {reason}',
  'docUpdate.extract.error.extractionFailed.fallback': '❌ 메시지에서 지식을 추출하지 못했어요.',
  'docUpdate.extract.error.modalOpenFailed': '❌ 수정 창을 열지 못했어요. 다시 시도해 주세요.',
  'docUpdate.extract.error.managerModalOpenFailed': '❌ 지식 수정 창을 열지 못했어요: {reason}',
  'docUpdate.extract.error.editFailed': '❌ 지식 수정을 처리하지 못했어요: {reason}',
  'docUpdate.extract.error.sendFailed': '❌ 매니저에게 제안을 보내지 못했어요. 잠시 후 다시 시도해 주세요.',
  'docUpdate.extract.error.applyFailed': '❌ 지식을 반영하지 못했어요: {reason}',
  'docUpdate.extract.error.dmLinkFailed': '❌ DM 링크를 만들지 못했어요. 다시 시도하거나 지원팀에 문의해 주세요.',
  'docUpdate.extract.error.cancelFailed': '❌ *취소하는 중에 오류가 생겼어요*\n{reason}',
  'docUpdate.extract.error.cancelFailed.fallback': '❌ 취소하지 못했어요: {reason}',
  'docUpdate.extract.error.reviewCancelNoSession':
    '세션 ID가 없어서 취소를 처리하지 못했어요. 다시 시도해 보고, 계속 이러면 지원팀에 문의해 주세요.',
  'docUpdate.extract.error.reviewCancelFailed':
    '😥 이런! 지금은 제안 검토를 취소하지 못했어요. 오류: {reason}. 다시 시도해 주세요!',
};
