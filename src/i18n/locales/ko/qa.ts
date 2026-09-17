import type { LocaleCatalog } from '../../types';

// keys missing here fall back to English.
//
// 해요체 throughout, the same voice CHOIR answers questions in. Two things the
// English does not have to decide: the asker is addressed as `{sender}님`, since
// a bare name reads as a label rather than a person, and the two modal titles
// are kept short on purpose — Slack rejects a view whose title is over 24
// characters, and `📢`/`🔒` already spend two of them.
export const qa: LocaleCatalog = {
  'qa.error.missingSession': '😅 이런, 문제가 생겼어요. 질문을 다시 해 주시겠어요?',
  'qa.error.noConversationDetails': '😅 대화 내용을 찾을 수 없어요. 질문을 다시 해 주시겠어요?',
  'qa.error.noChannel': '❌ Q&A 채널이 설정되어 있지 않아요. 관리자에게 Q&A 채널 설정을 요청해 주세요.',
  'qa.error.openShareModal': '😔 공유 옵션을 여는 중에 문제가 생겼어요. 다시 시도해 주시겠어요?',
  'qa.error.sessionExpired': '😅 원래 대화 내용을 찾을 수 없어요. 세션이 만료된 것 같아요.',
  'qa.error.startUpdate': '😔 문서 업데이트를 시작하는 중에 문제가 생겼어요. 다시 시도해 주세요.',

  'qa.share.sender.teamMember': '팀원',
  'qa.share.sender.theTeamMember': '그 팀원',
  'qa.share.sender.anonymous': '익명 사용자',
  'qa.share.preview.senderPlaceholder': '(*{name}* 또는 *팀원*)',
  'qa.share.image.alt.profile': '프로필 사진',
  'qa.share.image.alt.anonymous': '익명 사용자',

  'qa.share.channel.intro':
    '#{channelName} 여러분, 안녕하세요. {sender}님이 아래 질문을 했고, 제 답변은 이랬어요.\n\n*질문:*\n{question}',
  'qa.share.channel.unanswered': '그런데 제가 답을 드리지 못했어요. 혹시 도와주실 분 계신가요?',
  'qa.share.channel.discuss': '{sender}님이 이 답변을 다른 분들과 이야기해 보고 싶어 해요. 혹시 도와주실 분 계신가요?',
  'qa.share.response': '*제 답변:*\n{response}',
  'qa.share.comment': '*{author}님이 덧붙였어요:*\n{comment}',
  'qa.share.channel.preview.unanswered':
    '#{channelName} 여러분, 안녕하세요.\n{sender}님이 아래 질문을 했고, 제 답변은 이랬어요.\n\n*질문:*\n```{question}```\n\n그런데 제가 답을 드리지 못했어요. 혹시 도와주실 분 계신가요?',
  'qa.share.channel.preview.answered':
    '#{channelName} 여러분, 안녕하세요.\n{sender}님이 아래 질문을 했고, 제 답변은 이랬어요.\n\n*질문:*\n```{question}```\n\n*제 답변:*\n```{response}```\n\n다만 {sender}님이 이 내용을 다른 분들과 이야기해 보고 싶어 해요. 혹시 도와주실 분 계신가요?',

  'qa.private.intro': '안녕하세요!\n{sender}님이 저에게 아래 질문을 하고, 제 답변을 회원님께 공유했어요.',
  'qa.private.question': '*질문:*\n{question}',
  'qa.private.unanswered': '그런데 제가 답을 드리지 못했어요. 그 팀원이 이 질문에 도움을 받고 싶어 해요.',
  'qa.private.discuss': '{sender}님이 이 내용을 회원님과 이야기해 보고 싶어 해요. 도와주실 수 있을까요?',
  'qa.private.anonymousReplyHint':
    '💬 *질문한 사람에게 답하고 싶으세요?*\n이 스레드에 그대로 답장하시면 돼요. 답장은 익명 질문자에게 자동으로 전달돼요.',
  'qa.private.preview.unanswered':
    '안녕하세요!\n{sender}님이 저에게 아래 질문을 하고, 제 답변을 회원님께 공유했어요.\n\n*질문:*\n```{question}```\n\n그런데 제가 답을 드리지 못했어요. 그 팀원이 이 질문에 도움을 받고 싶어 해요.',
  'qa.private.preview.answered':
    '안녕하세요!\n{sender}님이 저에게 아래 질문을 하고, 제 답변을 회원님께 공유했어요.\n\n*질문:*\n```{question}```\n\n*제 답변:*\n```{response}```\n\n그 팀원이 이 내용을 회원님과 이야기해 보고 싶어 해요. 도와주실 수 있을까요?',

  'qa.shareModal.comment.label': '💭 내 코멘트',
  'qa.shareModal.comment.placeholder': '이 질문과 답변에 대한 생각이나 배경을 덧붙여 주세요 (선택)',
  'qa.shareModal.privacy.label': '🎭 공개 설정',
  'qa.shareModal.previewHeading': '👀 *이렇게 공유돼요:*',

  'qa.channelModal.title': '📢 Q&A 채널에 공유',
  'qa.channelModal.submit': '채널에 올리기',
  'qa.channelModal.intro':
    '📢 *이 Q&A를 #{channelName} 채널에 공유할까요?*\n_질문과 제 답변을 채널에 올려 다른 분들에게도 도움이 되게 해요. 원하시면 생각이나 배경을 덧붙일 수 있어요._',
  'qa.channelModal.anonymous.option': "익명으로 공유해요 (내 이름 대신 '팀원'으로 표시돼요)",

  'qa.channelSubmit.posted': '✅ Q&A를 {channel} 채널에 올렸어요',
  'qa.channelSubmit.error': '❌ 설정된 Q&A 채널에 Q&A를 올리지 못했어요. {reason}',
  'qa.channelSubmit.notInChannel':
    '봇이 설정된 Q&A 채널에 들어가 있지 않고, Slack 앱에 channels:join 권한이 없어서 자동으로 들어갈 수도 없어요. channels:join 권한을 추가하고 앱을 다시 설치하거나, 봇을 Q&A 채널에 직접 초대해 주세요.',

  'qa.othersModal.setup.text': '✅ 비공개 대화를 준비하고 있어요...',
  'qa.othersModal.setup': '✅ *비공개 대화를 준비하고 있어요...*\n참여자 선택 창을 여는 중이에요.',
  'qa.othersModal.title': '🔒 비공개로 질문하기',
  'qa.othersModal.submit': '비공개로 보내기',
  'qa.othersModal.intro':
    '🔒 *누구에게 비공개로 물어볼까요?*\n_선택한 분들에게 이 Q&A를 다이렉트 메시지로 보내 비공개로 이야기할 수 있어요. 원하시면 생각이나 배경을 덧붙일 수 있어요._',
  'qa.othersModal.people.label': '👤 받는 사람',
  'qa.othersModal.people.placeholder': '공유할 사람을 선택하세요...',
  'qa.othersModal.anonymous.option': "익명으로 공유해요 (내 이름 대신 '팀원'으로 표시하고 DM에서 나를 빼요)",

  'qa.othersSubmit.threadGuide.text': '이 스레드에서 편하게 이야기해 주세요! 답장은 익명 질문자에게 자동으로 전달돼요.',
  'qa.othersSubmit.threadGuide':
    '👋 이 스레드에서 편하게 이야기해 주세요!\n\n💡 *답장은 익명 질문자에게 자동으로 전달돼요.*\n\n🤖 *CHOIR의 도움이 필요하세요?* `@choir`로 불러 주시면 대화에 참여할게요!',
  'qa.othersSubmit.dmCreated.text': '✅ 비공개 DM을 만들었어요: {participants}',
  'qa.othersSubmit.dmCreated': '✅ *비공개 DM을 만들었어요*\n📋 참여자: {participants}',
  'qa.othersSubmit.dmReady.text': '비공개 DM으로 이동하기',
  'qa.othersSubmit.dmReady': '💬 *비공개 DM이 준비됐어요*\n아래 버튼을 눌러 대화를 열어 보세요.',
  'qa.othersSubmit.openDm.button': 'DM 열기',
  'qa.othersSubmit.dmFailed.text': '⚠️ 비공개 DM을 만들지 못했어요. 다시 시도해 주세요.',
  'qa.othersSubmit.dmFailed': '⚠️ *비공개 DM을 만들지 못했어요.* 잠시 후 다시 시도해 주세요.',

  'qa.answer.loading.text': '관련 문서를 찾아 답변을 준비하고 있어요... :mag: :brain:',
  'qa.answer.loading': ':mag: 관련 문서를 찾고 맥락을 살펴보고 있어요...',
  'qa.answer.indexing.text': 'Q&A 색인을 만들고 답변을 준비하고 있어요...',
  'qa.answer.indexing':
    ':hourglass_flowing_sand: Q&A 색인을 아직 만드는 중이라 첫 답변은 조금 더 걸릴 수 있어요. 준비되면 이 메시지를 업데이트할게요.',
  'qa.answer.context.answered': '{name}님의 질문에 답했어요',
  'qa.answer.context.responded': '{name}님의 질문에 응답했어요',
  'qa.answer.sourcesHint': '원문을 읽고 싶으시면 답변에 링크된 출처를 참고해 주세요.',
  'qa.answer.askChannel.button': 'Q&A 채널에 묻기',
  'qa.answer.askPrivate.button': '비공개로 묻기',
  'qa.answer.share.answered': '💡 이 내용을 더 이야기하거나 팀의 의견을 들어 볼까요?',
  'qa.answer.share.unanswered': '💬 문서에서 이 내용을 찾지 못했어요. 팀에 직접 물어볼까요?',
  'qa.answer.reference': '*참고 {index}*\n{source}\n```{content}```\n',
  'qa.answer.reference.source': '*출처:* {sources}\n',
  'qa.answer.error': '질문을 처리하는 중에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',

  'qa.managers.fallback': '매니저',
  'qa.managers.andOthers': '{name}님과 다른 매니저들',
  'qa.anonReply.analysis.text':
    '✅ 분석 완료 • 📊 메시지 10개 분석\n좋아요! {managers}에게 아래 업데이트를 제안할게요.',
  'qa.anonReply.analysis': '✅ *분석 완료* • 📊 메시지 10개 분석\n좋아요! {managers}에게 아래 업데이트를 제안할게요.',
  'qa.managerReply.analysis.text': '✅ 분석 완료 • 📊 메시지 10개 분석',
  'qa.managerReply.analysis': '✅ *분석 완료* • 📊 메시지 10개 분석\n좋아요! 아래 업데이트를 제안할게요.',
  'qa.dismissAnonymous.text': '답장 고마워요!',
  'qa.dismissAnonymous': '✅ *답장 고마워요!*\n나중에 문서 업데이트에 도움이 필요하면 저를 불러 주세요.',
  'qa.dismissManager.text': '답장을 보냈어요!',
  'qa.dismissManager':
    '✅ *익명 질문자에게 답장을 보냈어요!*\n나중에 문서 업데이트에 도움이 필요하면 저를 불러 주세요.',
};
