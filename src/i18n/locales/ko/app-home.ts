import type { LocaleCatalog } from '../../types';

// Korean overlay for the app-home feature; keys missing here fall back to English.
//
// The two language names (`option.english`, `option.korean`) are deliberately
// absent: a language is listed under its own name in every locale, so the
// English catalog is already correct Korean. The same goes for the handful of
// entries that are pure structure (`repo.label`, the `sk-...` placeholder).
//
// Modal titles are the tight ones: Slack caps a view title at 24 characters and
// the catalog test enforces that here, so every `.title` below stays short
// ("읽기 전용 파일 관리", not "읽기 전용으로 지정할 파일 관리하기").
//
// The home view's rows are one label line plus one status line, so the Korean
// keeps the same shape: a bold noun phrase, then a glyph and a short clause. The
// tab labels are nouns, not sentences, because they sit inside 75-char buttons.
//
// Counted nouns follow Korean word order (파일 3개), which is why the plural
// entries are not a word-for-word translation and why `{total}` comes before
// `{count}` in the "N of M" lines.
export const appHome: LocaleCatalog = {
  // --- 탭 바 ----------------------------------------------------------------
  'appHome.tabs.home': '🏠 홈',
  'appHome.tabs.documents': '📁 문서',
  'appHome.tabs.team': '👥 팀',
  'appHome.tabs.advanced': '⚙️ 고급',

  'appHome.language.mine.label': '*내 언어*\nCHOIR가 나에게 말할 때 쓰는 언어예요.',
  'appHome.language.mine.placeholder': '언어 선택',

  'appHome.language.workspace.label': '*워크스페이스 언어*',
  'appHome.language.workspace.context': '멤버가 따로 설정하지 않았을 때 CHOIR의 메시지와 버튼에 쓰는 기본 언어예요',
  'appHome.language.workspace.placeholder': '언어 선택',

  'appHome.language.content.label': '*문서 작성 언어*',
  'appHome.language.content.context':
    "CHOIR가 새 문서 내용을 쓸 때 사용하는 언어예요. '대화 언어를 따라가요'를 고르면 지금과 똑같이 동작해요",
  'appHome.language.content.placeholder': '언어 선택',

  'appHome.language.option.auto': '자동 (Slack 언어를 따라가요)',
  'appHome.language.option.followConversation': '대화 언어를 따라가요',

  'appHome.language.confirm.mine': '✅ 언어를 {language}로 설정했어요.',
  'appHome.language.confirm.mineAuto': '✅ 언어를 자동으로 설정했어요. CHOIR가 {language}로 말할게요.',
  'appHome.language.confirm.workspace': '✅ 워크스페이스 언어를 {language}로 설정했어요.',
  'appHome.language.confirm.content': '✅ 문서 작성 언어를 {language}로 설정했어요.',

  // --- 홈: 첫 인사 ----------------------------------------------------------
  'appHome.welcome.greeting': '*{user}님, 반가워요* :wave:',
  'appHome.welcome.intro': 'CHOIR는 팀 문서에서 답을 찾아 주고, Slack 대화를 문서 업데이트로 바꿔 줘요.',
  'appHome.welcome.startChat.button': '💬 CHOIR와 대화 시작하기',
  'appHome.docs.open.button': '📖 문서 열기',
  'appHome.insights.open.button': '📊 팀 인사이트 열기',

  // --- 홈: 매니저용 설정 카드 -----------------------------------------------
  'appHome.home.setup.label': '*설정 상태*',
  'appHome.home.setup.github.done': '✅ GitHub 계정 · {login}',
  'appHome.home.setup.github.todo': '*GitHub 계정*\n❌ 연결되지 않았어요 · 저장소를 고르려면 먼저 연결해 주세요',
  'appHome.home.setup.repo.done': '✅ 저장소 · {repo}',
  'appHome.home.setup.repo.todo': '*저장소*\n❌ 없어요 · CHOIR가 읽을 저장소를 골라 주세요',
  'appHome.home.setup.channel.done': '✅ Q&A 채널 · #{channel}',
  'appHome.home.setup.channel.todo':
    '*Q&A 채널*\n❌ 설정되지 않았어요 · 채널을 고르기 전까지 "채널에 질문하기"는 꺼져 있어요',
  'appHome.home.setup.people.done': '✅ CHOIR 사용자 {users}명 · 매니저 {managers}명',

  // --- 고급: AI 모델 --------------------------------------------------------
  'appHome.advanced.openai.summary':
    '*AI 모델*\n키: {keyStatus} · Q&A: {qaModel} · 문서 업데이트: {documentUpdateModel}',
  'appHome.advanced.openai.context': '분류 모델: {classificationModel} (고정)',
  'appHome.openai.key.workspaceSet': '✅ 워크스페이스 키 ({masked})',
  'appHome.openai.key.serverDefault': '🟡 서버 기본 키',
  'appHome.openai.key.notConfigured': '❌ 설정되지 않음',
  'appHome.openai.model.serverDefault': '서버 기본값',
  'appHome.openai.configure.button': 'OpenAI 설정',
  'appHome.openai.clear.button': '설정 지우기',
  'appHome.openai.clear.confirm.title': 'OpenAI 설정을 지울까요?',
  'appHome.openai.clear.confirm.text':
    'CHOIR가 서버 기본 키로 돌아가요. 이 워크스페이스에 저장된 키와 모델 선택은 삭제돼요.',
  'appHome.openai.clear.confirm.ok.button': '지우기',

  // --- 고급: 변경 이력 암호화 키 --------------------------------------------
  'appHome.advanced.contextKey.configured': '*변경 이력 암호화*\n✅ 키가 설정돼 있어요{details}',
  'appHome.advanced.contextKey.notGenerated':
    '*변경 이력 암호화*\n🟡 아직 없어요 · 변경 이력이 처음 기록될 때 만들어져요',
  'appHome.contextKey.status.created': '{date} 생성',
  'appHome.contextKey.status.rotated': '{date} 교체',
  'appHome.contextKey.backup.button': '키 백업',
  'appHome.contextKey.rotate.button': '키 교체',
  'appHome.contextKey.import.button': '키 가져오기',
  'appHome.contextKey.warning':
    '⚠️ 키를 교체하거나 새로 가져오면 *지금까지 기록된 변경 이력을 모두 영원히 읽을 수 없게 돼요*. 예전 이력이 필요할 수 있다면 먼저 현재 키를 백업해 주세요.',

  // --- 팀: 매니저, CHOIR 사용자, Q&A 채널, 조직 ------------------------------
  'appHome.team.managers.summary': '*매니저* ({count}명)\n{list}',
  'appHome.team.managers.none': '*매니저*\n아직 매니저가 없어요.',
  'appHome.team.choirUsers.summary': '*CHOIR 사용자*\n{count}명 등록됨',
  'appHome.team.qaChannel.configured': '*Q&A 채널*\n✅ #{channel}',
  'appHome.team.qaChannel.notConfigured':
    '*Q&A 채널*\n❌ 설정되지 않았어요 · 채널을 고르기 전까지 "채널에 질문하기"는 꺼져 있어요',
  'appHome.team.qaChannel.notFound': '*Q&A 채널*\n⚠️ 저장된 채널을 찾을 수 없어요 · 다른 채널을 골라 주세요',
  'appHome.team.organization.summary': '*조직*\n{name}',
  'appHome.choirManagement.managers.button': '매니저 관리',
  'appHome.choirManagement.choirUsers.button': 'CHOIR 사용자 관리',
  'appHome.choirManagement.qaChannel.placeholder': '채널 선택',

  // --- 홈: 매니저가 아닌 사람에게 보이는 안내 -------------------------------
  'appHome.becomeManager.hint': '🔒 _고급 기능이 필요하신가요? 워크스페이스 관리자에게 문의해 주세요._',
  'appHome.becomeManager.button': '매니저 권한',

  // --- 문서: GitHub 연결, 저장소, 파일, 인덱스 관리 --------------------------
  'appHome.documents.github.connected': '*GitHub 계정*\n✅ {login} · {date} 연결',
  'appHome.documents.github.notConnected': '*GitHub 계정*\n❌ 연결되지 않았어요 · 저장소를 고르려면 먼저 연결해 주세요',
  'appHome.documents.repo.connected': '*저장소*\n✅ {repoLink}',
  'appHome.documents.repo.notConnected': '*저장소*\n❌ 없어요 · CHOIR가 읽을 저장소를 골라 주세요',
  'appHome.documents.repo.change.button': '바꾸기',
  'appHome.documents.readOnly.summary': '*읽기 전용 파일*\n파일 {total}개 중 {count}개가 업데이트에서 빠져 있어요',
  'appHome.documents.readOnly.current': '지금 빠져 있는 파일: {list}',
  'appHome.documents.readOnly.currentNone': '지금은 빠진 파일이 없어요.',
  'appHome.documents.readOnly.more': '외 {count}개',
  'appHome.documents.readOnly.needsRepo': '*읽기 전용 파일*\n🟡 저장소를 먼저 연결해 주세요',
  'appHome.documents.projects.summary': {
    other: '*프로젝트*\n폴더 {count}개가 Slack 채널과 연결돼 있어요',
  },
  'appHome.documents.projects.none': '*프로젝트*\n아직 프로젝트 폴더가 없어요',
  'appHome.documents.projects.item': '*{name}*\n`{folder}` · {channels}',
  'appHome.documents.projects.channels': {
    other: '채널 {count}개',
  },
  'appHome.documents.projects.context':
    '프로젝트는 연결된 채널의 질문과 갱신을 그 폴더 안에서 처리해요. 설정은 문서 뷰어에서 열려요.',
  'appHome.projects.settings.button': '설정',
  'appHome.documents.readOnly.loading': '*읽기 전용 파일*\n🟡 GitHub에서 파일을 불러오는 중이에요…',
  'appHome.documentConnection.disconnect.button': 'GitHub 연결 해제',
  'appHome.documentConnection.disconnect.confirm.title': 'GitHub 연결 해제',
  'appHome.documentConnection.disconnect.confirm.text': '개인 GitHub 계정 연결을 해제할까요?',
  'appHome.documentConnection.disconnect.confirm.ok.button': '연결 해제',
  'appHome.documentConnection.connect.button': 'GitHub 계정 연결',
  'appHome.documentConnection.repo.labelWithPath': '{owner}/{repo} (경로: {path})',
  'appHome.documentConnection.browse.button': '내 저장소 둘러보기',
  'appHome.documentConnection.indexManagement.summary':
    '*인덱스 정비*\n마크다운 파일을 수정한 뒤나 답변이 오래된 것 같을 때 실행해 주세요.',
  'appHome.documentConnection.normalize.button': '마크다운 정규화',
  'appHome.documentConnection.normalize.confirm.title': '마크다운 파일 정규화',
  'appHome.documentConnection.normalize.confirm.text':
    '모든 마크다운 파일을 트리 형식으로 바꿨다가 다시 마크다운으로 되돌려 서식을 통일해요. 줄바꿈이나 목록 표기가 달라질 수 있어요.',
  'appHome.documentConnection.normalize.confirm.ok.button': '정규화',
  'appHome.documentConnection.reload.button': 'GitHub에서 다시 불러오기',
  'appHome.documentConnection.reload.confirm.title': 'GitHub에서 다시 불러올까요?',
  'appHome.documentConnection.reload.confirm.text':
    'GitHub에서 최신 파일을 가져와 벡터 스토어를 업데이트해요. 저장하지 않은 변경 사항은 덮어써져요.',
  'appHome.documentConnection.reload.confirm.ok.button': '다시 불러오기',
  'appHome.documentConnection.rebuildQmd.button': 'QMD 인덱스 재생성',
  'appHome.documentConnection.rebuildQmd.confirm.title': 'QMD 인덱스를 재생성할까요?',
  'appHome.documentConnection.rebuildQmd.confirm.text':
    '로컬 QMD SQLite 인덱스를 지우고 동기화된 마크다운 미러에서 다시 만들어요. 청크 방식을 바꿨거나 검색 결과가 오래된 것 같을 때 사용해 주세요.',
  'appHome.documentConnection.rebuildQmd.confirm.ok.button': '재생성',

  // --- 팀 + 모달: 조직 이름 -------------------------------------------------
  'appHome.organization.defaultName': '우리 조직',
  'appHome.organization.edit.button': '조직 이름 수정',
  'appHome.organization.edit.title': '조직 이름 수정',
  'appHome.organization.edit.submit': '변경 사항 저장',
  'appHome.organization.edit.label': '조직 이름',
  'appHome.organization.edit.placeholder': '조직 이름을 입력해 주세요 (예: 스미스 연구실, AI 팀 등)',
  'appHome.organization.edit.success': '✅ 조직 이름을 "{name}"(으)로 바꿨어요!',
  'appHome.organization.edit.error.open': '❌ 수정 창을 여는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.organization.edit.error.required': '조직 이름을 입력해 주세요.',
  'appHome.organization.edit.error.save': '조직 이름을 바꾸는 중에 문제가 생겼어요. 다시 시도해 주세요.',

  // --- 고급 + DM: 상호작용 로그 다운로드 ------------------------------------
  'appHome.advanced.logs.summary': '*로그 내려받기*\n분석과 연구를 위한 상호작용 로그예요.',
  'appHome.logs.today.button': '오늘 로그',
  'appHome.logs.today.preparing': '📊 오늘의 상호작용 로그를 준비하고 있어요...',
  'appHome.logs.today.fileTitle': '오늘의 상호작용 로그',
  'appHome.logs.today.comment': '📊 분석용 오늘({date}) 상호작용 로그예요.',
  'appHome.logs.today.uploaded': '✅ 오늘의 상호작용 로그를 올렸어요 ({size}KB)',
  'appHome.logs.all.button': '전체 로그',
  'appHome.logs.all.preparing': '📊 전체 상호작용 로그를 준비하고 있어요...',
  'appHome.logs.all.fileTitle': '전체 상호작용 로그',
  'appHome.logs.all.comment': '📊 분석용 전체 상호작용 로그예요.',
  'appHome.logs.all.uploaded': '✅ 전체 상호작용 로그를 올렸어요 ({size}KB)',
  'appHome.logs.error.none': '❌ 상호작용 로그가 없어요.',
  'appHome.logs.error.noneToday': '❌ 오늘({date}) 상호작용 로그 파일이 없어요.',
  'appHome.logs.error.noneAll': '❌ 상호작용 로그 파일이 없어요.',
  'appHome.logs.error.upload': '❌ 로그 파일을 올리는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.logs.error.prepare': '❌ 상호작용 로그를 준비하는 데 실패했어요. 다시 시도해 주세요.',

  // --- 고급: 파일 로깅 스위치 -----------------------------------------------
  'appHome.advanced.logging.enabled': '*상호작용 로깅*\n✅ 켜짐 · 연구를 위해 상호작용을 로그 파일에 저장해요',
  'appHome.advanced.logging.disabled': '*상호작용 로깅*\n❌ 꺼짐 · 로그 파일에 아무것도 남기지 않아요',
  'appHome.logging.enable.button': '로깅 켜기',
  'appHome.logging.disable.button': '로깅 끄기',

  // --- 문서: 읽기 전용 파일 -------------------------------------------------
  'appHome.readOnly.manage.button': '읽기 전용 파일 관리',

  // --- 관리: 권한이 없을 때의 안내 ------------------------------------------
  'appHome.management.error.permissionDenied': '❌ 이 작업을 할 권한이 없어요.',

  // --- 관리: 매니저 모달 ----------------------------------------------------
  'appHome.management.managers.title': '매니저 관리',
  'appHome.management.managers.submit': '매니저 업데이트',
  'appHome.management.managers.intro':
    '👑 *매니저 선택*\n\n워크스페이스 멤버 중 누구에게 매니저 권한을 줄지 골라 주세요. 매니저는 고급 기능을 쓸 수 있고 다른 사용자에게 권한을 줄 수 있어요.',
  'appHome.management.managers.status': { other: '📊 *현재 상태:* 매니저 {count}명 지정됨' },
  'appHome.management.managers.label': '매니저',
  'appHome.management.managers.placeholder': '매니저로 지정할 사용자를 선택해 주세요...',
  'appHome.management.managers.hint': '선택한 사용자는 매니저 권한과 모든 CHOIR 관리 기능을 쓸 수 있어요.',
  'appHome.management.managers.warning':
    '⚠️ *주의:* 매니저 권한을 없애면 그 사람이 CHOIR 설정을 관리하지 못할 수 있어요.',
  'appHome.management.managers.result.added': '✅ {user}에게 매니저 권한을 줬어요',
  'appHome.management.managers.result.addFailed': '❌ {user}에게 매니저 권한을 주지 못했어요',
  'appHome.management.managers.result.addError': '❌ {user}에게 매니저 권한을 주는 중에 오류가 났어요',
  'appHome.management.managers.result.removed': '✅ {user}의 매니저 권한을 없앴어요',
  'appHome.management.managers.result.removeFailed': '❌ {user}의 매니저 권한을 없애지 못했어요',
  'appHome.management.managers.result.removeError': '❌ {user}의 매니저 권한을 없애는 중에 오류가 났어요',
  'appHome.management.managers.updated': {
    other: '✅ 매니저 권한을 업데이트했어요! 지금은 매니저 {count}명이 지정돼 있어요.{changes}',
  },
  'appHome.management.managers.noChanges': '✅ 매니저 권한에 바뀐 내용이 없어요.',
  'appHome.management.managers.error.open': '❌ 매니저 관리 창을 여는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.management.managers.error.empty': '매니저를 한 명 이상 선택하거나, 취소하고 지금 설정을 유지해 주세요.',
  'appHome.management.managers.error.permission': '❌ 매니저를 관리할 권한이 없어요.',
  'appHome.management.managers.error.partial': '일부 매니저 권한 변경에 실패했어요. 다시 시도해 주세요.',
  'appHome.management.managers.error.generic': '매니저를 업데이트하는 중에 문제가 생겼어요. 다시 시도해 주세요.',

  // --- 관리: CHOIR 사용자 모달 ----------------------------------------------
  'appHome.management.choirUsers.title': 'CHOIR 사용자 관리',
  'appHome.management.choirUsers.submit': '사용자 업데이트',
  'appHome.management.choirUsers.intro':
    '👥 *CHOIR 사용자 선택*\n\n워크스페이스 멤버 중 누가 CHOIR 기능을 쓰고 연구에 참여할지 골라 주세요. 매니저는 자동으로 포함돼요.',
  'appHome.management.choirUsers.status': { other: '📊 *현재 상태:* 사용자 {count}명 등록됨' },
  'appHome.management.choirUsers.label': 'CHOIR 사용자',
  'appHome.management.choirUsers.placeholder': 'CHOIR에 포함할 사용자를 선택해 주세요...',
  'appHome.management.choirUsers.hint': '선택한 사용자는 CHOIR 기능을 쓸 수 있어요. 매니저는 자동으로 포함돼요.',
  'appHome.management.choirUsers.privacy':
    '🔒 *개인정보 안내:* 선택한 사용자의 메시지만 CHOIR의 대화 기록과 연구 데이터에 포함돼요.',
  'appHome.management.choirUsers.updated': {
    other:
      '✅ CHOIR 사용자를 업데이트했어요! 지금은 사용자 {count}명이 등록돼 있어요. 앱 홈을 새로고침하면 바뀐 내용을 볼 수 있어요.',
  },
  'appHome.management.choirUsers.error.open': '❌ 사용자 관리 창을 여는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.management.choirUsers.error.empty': '사용자를 한 명 이상 선택하거나, 취소하고 지금 설정을 유지해 주세요.',
  'appHome.management.choirUsers.error.save': '❌ CHOIR 사용자를 업데이트하지 못했어요. 다시 시도해 주세요.',
  'appHome.management.choirUsers.error.generic': '사용자를 업데이트하는 중에 문제가 생겼어요. 다시 시도해 주세요.',
  'appHome.management.choirUsers.error.postAck':
    '❌ CHOIR 사용자를 업데이트하는 중에 문제가 생겼어요. 다시 시도해 주세요.',

  // --- 관리: 읽기 전용 파일 모달 --------------------------------------------
  'appHome.management.readOnly.title': '읽기 전용 파일 관리',
  'appHome.management.readOnly.submit': '파일 업데이트',
  'appHome.management.readOnly.intro':
    '🔒 *읽기 전용 파일 선택*\n\n읽기 전용 파일은 문서 업데이트에서 빠지지만 검색은 그대로 돼요. 자동 업데이트에서 보호할 파일을 골라 주세요.',
  'appHome.management.readOnly.status': '📊 *현재 상태:* 파일 {total}개 중 {count}개가 읽기 전용이에요',
  'appHome.management.readOnly.label': '읽기 전용으로 지정할 파일 선택',
  'appHome.management.readOnly.placeholder': '읽기 전용으로 지정할 파일을 검색해 주세요...',
  'appHome.management.readOnly.tip':
    '💡 *팁:* 읽기 전용 파일도 검색하고 참조할 수 있지만, 문서 업데이트 때 수정되지는 않아요. `/`로 끝나는 폴더를 고르면 그 안의 문서 전부가 보호돼요.',
  'appHome.management.readOnly.updated': {
    other:
      '✅ 읽기 전용 파일을 업데이트했어요! 지금은 파일 {count}개가 읽기 전용이에요. 앱 홈을 새로고침하면 바뀐 내용을 볼 수 있어요.',
  },
  'appHome.management.readOnly.error.noFiles': '❌ 마크다운 파일이 없어요. 먼저 GitHub 저장소를 연결해 주세요.',
  'appHome.management.readOnly.error.open': '❌ 읽기 전용 파일 관리 창을 여는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.management.readOnly.error.save': '읽기 전용 파일을 업데이트하지 못했어요. 다시 시도해 주세요.',
  'appHome.management.readOnly.error.generic':
    '읽기 전용 파일을 업데이트하는 중에 문제가 생겼어요. 다시 시도해 주세요.',

  // --- 관리: 비밀번호로 매니저 되기 -----------------------------------------
  'appHome.management.promotion.title': '매니저 되기',
  'appHome.management.promotion.intro': '🔐 *매니저 승급*\n\n매니저 권한을 받으려면 승급 비밀번호를 입력해 주세요.',
  'appHome.management.promotion.label': '비밀번호',
  'appHome.management.promotion.placeholder': '승급 비밀번호를 입력해 주세요...',
  'appHome.management.promotion.success':
    '✅ 축하해요! 매니저가 됐어요. 앱 홈을 새로고침하면 바뀐 내용을 볼 수 있어요.',
  'appHome.management.promotion.error.open': '❌ 매니저 승급 창을 여는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.management.promotion.error.empty': '승급 비밀번호를 입력해 주세요.',
  'appHome.management.promotion.error.invalid': '비밀번호가 맞지 않아요. 다시 확인하고 시도해 주세요.',
  'appHome.management.promotion.error.generic': '요청을 처리하는 중에 문제가 생겼어요. 다시 시도해 주세요.',

  // --- 관리: Q&A 채널 선택 --------------------------------------------------
  'appHome.management.qaChannel.success': '✅ Q&A 채널을 #{channel}로 설정했어요.',
  'appHome.management.qaChannel.error.permission': '❌ Q&A 채널을 바꿀 권한이 없어요.',
  'appHome.management.qaChannel.error.access':
    '❌ 선택한 채널에 접근할 수 없어요. CHOIR를 채널에 초대하거나 공개 채널을 골라 주세요.',
  'appHome.management.qaChannel.error.generic': '❌ Q&A 채널을 설정하지 못했어요. 다시 시도해 주세요.',

  // --- 관리: 파일 로깅 스위치 -----------------------------------------------
  'appHome.management.logging.enabled': '✅ 로깅을 켰어요. 앱 홈을 새로고침하면 바뀐 내용을 볼 수 있어요.',
  'appHome.management.logging.disabled': '❌ 로깅을 껐어요. 앱 홈을 새로고침하면 바뀐 내용을 볼 수 있어요.',
  'appHome.management.logging.error': '❌ 로깅 설정을 바꾸는 데 실패했어요. 다시 시도해 주세요.',

  // --- 관리: OpenAI 키와 모델 모달 ------------------------------------------
  'appHome.management.openai.title': 'OpenAI 설정',
  'appHome.management.openai.submit': '저장',
  'appHome.management.openai.intro':
    '🔐 *OpenAI API 키 & 모델*\n이 워크스페이스에서 CHOIR가 쓸 키를 관리하고, Q&A와 문서 업데이트에 쓸 GPT-5 모델을 골라 주세요. 분류는 언제나 고정된 모델을 써요.',
  'appHome.management.openai.apiKey.label': 'API 키',
  'appHome.management.openai.apiKey.hint.existing': '현재 키: {masked}. 비워 두면 그대로 유지해요.',
  'appHome.management.openai.apiKey.hint.new': 'OpenAI API 키를 붙여넣어 주세요. 저장하기 전에 확인해요.',
  'appHome.management.openai.model.placeholder': '기본값 사용',
  'appHome.management.openai.qaModel.label': 'Q&A 모델',
  'appHome.management.openai.documentUpdateModel.label': '문서 업데이트 모델',
  'appHome.management.openai.saved': '✅ OpenAI 설정을 저장했어요.',
  'appHome.management.openai.cleared': '✅ 워크스페이스 OpenAI 설정을 지웠어요. CHOIR가 서버 기본 키로 돌아가요.',
  'appHome.management.openai.error.permission': '❌ OpenAI 설정을 바꿀 권한이 없어요.',
  'appHome.management.openai.error.open': '❌ OpenAI 설정을 여는 데 실패했어요. 다시 시도해 주세요.',
  'appHome.management.openai.error.validation': '키 확인에 실패했어요: {reason}',
  'appHome.management.openai.error.unknownReason': '알 수 없는 오류',
  'appHome.management.openai.error.save': '저장하는 중에 문제가 생겼어요. 다시 시도해 주세요.',
  'appHome.management.openai.error.postAck':
    '⚠️ OpenAI 설정이 다 저장되지 않았을 수 있어요. 설정을 다시 열고 시도해 주세요.',

  // --- 관리: 출처 키 교체·백업·가져오기 -------------------------------------
  'appHome.management.contextKey.confirm.label': '확인하려면 {phrase}를 입력해 주세요',
  'appHome.management.contextKey.confirm.error': '확인하려면 {phrase}를 정확히 입력해 주세요.',
  'appHome.management.contextKey.rotate.title': '키 교체',
  'appHome.management.contextKey.rotate.submit': '교체',
  'appHome.management.contextKey.rotate.warning':
    '⚠️ *지금 있는 변경 이력에 영원히 접근할 수 없게 돼요.*\n\n지금까지 기록된 업데이트(대화, 추출한 지식, diff)는 모두 현재 키로 암호화돼 있어요. 새 키로는 풀 수 없어서 그 기록들은 영영 읽을 수 없어요. 예전 이력이 필요할 수 있다면 먼저 현재 키를 백업해 주세요.',
  'appHome.management.contextKey.rotate.success':
    '🔐 출처 키를 교체했어요. 새 변경 이력은 새 키를 쓰고, 이전 키로 기록한 내용은 더 이상 읽을 수 없어요.',
  'appHome.management.contextKey.rotate.error.modal': '키를 교체하지 못했어요. 다시 시도해 주세요.',
  'appHome.management.contextKey.rotate.error.postAck': '❌ 출처 키를 교체하지 못했어요. 다시 시도해 주세요.',
  'appHome.management.contextKey.backup.title': '키 백업',
  'appHome.management.contextKey.backup.close': '완료',
  'appHome.management.contextKey.backup.intro':
    '*출처 키(base64)예요.* 안전하고 비공개인 곳에 보관해 주세요. 이 키가 있으면 누구나 이 워크스페이스의 변경 이력을 복호화할 수 있어요. 키를 교체하거나 데이터베이스를 복원한 뒤 기존 이력을 읽으려면 이 키가 필요해요.',
  'appHome.management.contextKey.backup.missing': '아직 출처 키가 없어요. 문서 변경이 처음 기록될 때 만들어져요.',
  'appHome.management.contextKey.import.title': '키 가져오기',
  'appHome.management.contextKey.import.submit': '가져오기',
  'appHome.management.contextKey.import.warning.configured':
    '⚠️ 키를 가져오면 *지금 키를 대체해요*. 현재 키로 암호화된 변경 이력은 그 키를 다시 가져오기 전까지 읽을 수 없어요. 확실하지 않다면 먼저 백업해 주세요.',
  'appHome.management.contextKey.import.warning.new':
    '다른 환경에서 백업한 base64 인코딩 32바이트 키로 이 워크스페이스의 출처 키를 설정해요.',
  'appHome.management.contextKey.import.key.label': 'base64 키 (32바이트)',
  'appHome.management.contextKey.import.key.placeholder': 'base64 키를 붙여넣어 주세요',
  'appHome.management.contextKey.import.success':
    '🔐 출처 키를 가져왔어요. 지금부터 기록되는 변경 이력은 이 키를 쓰고, 이 키로 암호화된 이력(예: 복원한 백업)은 다시 읽을 수 있어요.',
  'appHome.management.contextKey.import.error.invalidKey': 'base64 인코딩 32바이트 키를 입력해 주세요.',
  'appHome.management.contextKey.import.error.modal': '키를 가져오지 못했어요. 다시 시도해 주세요.',
  'appHome.management.contextKey.import.error.postAck': '❌ 출처 키를 가져오지 못했어요. 다시 시도해 주세요.',
};
