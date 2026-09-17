/**
 * The viewer's Korean catalog.
 *
 * An overlay, not a copy: it is typed as `LocaleCatalog` (a `Partial` over
 * English's keys), so a key added to English ships in English here until
 * somebody translates it, and a key deleted from English fails to compile.
 * Korean's plural rules have a single category, so counted entries carry only
 * `other`.
 */

import type { LocaleCatalog } from '../types';

export const ko: LocaleCatalog = {
  // ── Shared ──────────────────────────────────────────────────────────────
  'common.button.cancel': '취소',
  'common.button.close': '닫기',
  'common.loading': '불러오는 중…',
  'common.unknownUser': '알 수 없음',

  // ── App shell ───────────────────────────────────────────────────────────
  'app.invalidUrl': '잘못된 주소입니다. {path} 형식이어야 합니다.',

  // ── Document header ─────────────────────────────────────────────────────
  'header.sidebar.show': '사이드바 보기',
  'header.sidebar.hide': '사이드바 숨기기',

  // ── File sidebar ────────────────────────────────────────────────────────
  'sidebar.aria.documents': '문서',
  'sidebar.repo.fallback': '저장소',
  'sidebar.files': '파일 {count}개',
  'sidebar.filesOnBranch': '{branch} 브랜치의 파일 {count}개',
  'sidebar.insights': '인사이트',

  // ── Floating outline ────────────────────────────────────────────────────
  'toc.aria.label': '목차',

  // ── Document viewer ─────────────────────────────────────────────────────
  'viewer.error.prefix': '오류:',
  'viewer.error.signInRequired': '로그인이 필요합니다',
  'viewer.error.loadFailed': '문서를 불러오지 못했습니다',
  'viewer.error.saveFailed': '저장하지 못했습니다',
  'viewer.error.deleteFailed': '삭제하지 못했습니다',
  'viewer.confirm.unsavedChanges': '저장하지 않은 변경 사항이 사라집니다. 계속할까요?',
  'viewer.confirm.discard': '저장하지 않은 변경 사항을 모두 버릴까요?',
  'viewer.loadingDocument': '문서를 불러오는 중…',
  'viewer.notice.deletedLast': '문서를 삭제했습니다. 이 저장소에는 남은 마크다운 문서가 없습니다.',
  'viewer.notice.committed': '{sha} 커밋을 만들고 색인을 새로 고쳤습니다.',
  'viewer.notice.saved': '저장했습니다.',
  'viewer.notice.dismiss.aria': '알림 닫기',
  'viewer.notice.dismiss.title': '닫기',
  'viewer.button.qaUsage': 'Q&A 사용량',
  'viewer.button.qaUsage.title': '질문에 답하는 데 쓰인 섹션을 강조합니다',
  'viewer.button.history': '변경 기록',
  'viewer.button.history.title': '변경 기록',
  'viewer.button.doneEditing': '편집 완료',
  'viewer.button.editDocument': '문서 편집',
  'viewer.button.delete': '삭제…',
  'viewer.button.discard': '되돌리기',
  'viewer.button.save': '저장…',
  'viewer.button.noChanges': '변경 없음',
  'viewer.button.signOut': '로그아웃',
  'viewer.button.editAsManager': '관리자로 편집',
  'viewer.readOnly': '읽기 전용',
  'viewer.changedBlocks': { other: '변경된 블록 {count}개' },
  'viewer.aria.closeSidebar': '사이드바 닫기',
  'viewer.marker.title': '변경 기록 보기',
  'viewer.usage.legend': '음영이 있는 섹션은 질문에 답하는 데 사용된 부분입니다(진할수록 자주 사용됨).',
  'viewer.usage.unmatched': { other: '검색 {count}건은 그 뒤로 바뀐 섹션을 가리킵니다.' },
  'viewer.usage.tooltip': { other: '최근 12주 동안 질문 {count}건에 사용됨; 그중 {unanswered}건은 답하지 못함' },
  'viewer.commit.defaultMessage': '{path} 업데이트',

  // ── Commit dialog ───────────────────────────────────────────────────────
  'commit.aria.dialog': '변경 사항 커밋',
  'commit.title': '변경 사항 커밋',
  'commit.subtitle': 'GitHub 저장소에 새 커밋이 푸시됩니다. Q&A 검색과 QMD 색인은 자동으로 갱신됩니다.',
  'commit.label.message': '커밋 메시지',
  'commit.button.submitting': '커밋하는 중…',
  'commit.button.submit': '커밋 후 푸시',

  // ── Delete dialog ───────────────────────────────────────────────────────
  'delete.aria.dialog': '문서 삭제',
  'delete.title': '이 문서를 삭제합니다',
  'delete.body':
    '{path} 문서가 저장소에서 삭제되고 더 이상 질문에 답하지 않습니다. Google Docs 사본이 있다면 연결이 끊기고 검토 대기 중인 변경도 함께 사라집니다. git에서 잃는 것은 없습니다 — 커밋 기록에 모든 버전이 남아 있으므로 거기서 복원할 수 있습니다.',
  'delete.body.onBranch':
    '{path} 문서가 {branch} 브랜치의 저장소에서 삭제되고 더 이상 질문에 답하지 않습니다. Google Docs 사본이 있다면 연결이 끊기고 검토 대기 중인 변경도 함께 사라집니다. git에서 잃는 것은 없습니다 — 커밋 기록에 모든 버전이 남아 있으므로 거기서 복원할 수 있습니다.',
  'delete.label.confirm': '확인을 위해 {path} 을(를) 입력하세요',
  'delete.button.submitting': '삭제하는 중…',
  'delete.button.submit': '문서 삭제',

  // ── Change history ──────────────────────────────────────────────────────
  'history.type.update': '수정',
  'history.type.append': '추가',
  'history.type.newFile': '새 파일',
  'history.type.webEdit': '직접 편집',
  'history.type.gdocsEdit': 'Google Docs 편집',
  'history.time.justNow': '방금',
  'history.aria.panel': '변경 기록',
  'history.title': '변경 기록',
  'history.aria.close': '닫기',
  'history.search.placeholder': '대화, 지식, 변경 내용 검색',
  'history.aria.filterAuthor': '작성자로 거르기',
  'history.filter.allAuthors': '모든 작성자',
  'history.aria.filterDate': '기간으로 거르기',
  'history.filter.allTime': '전체 기간',
  'history.filter.last24h': '최근 24시간',
  'history.filter.last7d': '최근 7일',
  'history.filter.last30d': '최근 30일',
  'history.aria.sort': '정렬',
  'history.sort.newest': '최신순',
  'history.sort.size': '변경량순',
  'history.empty.membersOnly': '변경 기록은 워크스페이스 구성원만 볼 수 있습니다.',
  'history.button.signIn': 'Slack으로 로그인',
  'history.empty.authRequired': '이 워크스페이스의 구성원만 변경 기록을 볼 수 있습니다.',
  'history.button.signInAgain': '다시 로그인',
  'history.empty.loadFailed': '변경 기록을 불러오지 못했습니다.',
  'history.empty.none': '아직 변경 기록이 없습니다.',
  'history.empty.noMatches': '조건에 맞는 변경 기록이 없습니다.',
  'history.linesChanged': '{count}줄 변경',
  'history.section.knowledge': '추출된 지식',
  'history.section.conversation': '대화',
  'history.section.changes': '변경 내용',
  'history.aria.viewMode': '보기 방식 변경',
  'history.view.diff': '차이',
  'history.view.before': '이전',
  'history.view.after': '이후',
  'history.diff.empty': '표시할 변경 내용이 없습니다.',
  'history.diff.noPrevious': '(이전 내용 없음)',

  // ── Awareness dashboard ─────────────────────────────────────────────────
  'dashboard.error.load': '대시보드 데이터를 불러오지 못했습니다.',
  'dashboard.aria.views': '보기',
  'dashboard.tab.docs': '문서',
  'dashboard.tab.insights': '인사이트',
  'dashboard.signIn.prompt': '팀 인사이트를 보려면 로그인하세요.',
  'dashboard.signIn.button': '로그인',
  'dashboard.membersOnly': '인사이트는 등록된 CHOIR 구성원만 볼 수 있습니다.',
  'dashboard.title': '팀 인사이트',
  'dashboard.stat.questions': '받은 질문',
  'dashboard.stat.answered': '문서로 답한 비율',
  'dashboard.stat.topics': '활성 주제',
  'dashboard.section.weekly': '주별 질문 수',
  'dashboard.section.topics': '주요 주제',
  'dashboard.section.topics.sub':
    '팀이 가장 많이 묻는 내용입니다. 문서로 답한 것과 아직 답하지 못한 것을 나눠 보여줍니다.',
  'dashboard.section.gaps': '문서의 빈틈',
  'dashboard.section.gaps.sub': '자주 묻지만 문서가 답하지 못한 주제입니다.',
  'dashboard.section.docUsage': '문서 사용량',
  'dashboard.section.docUsage.sub': 'CHOIR가 답변에 참고하는 문서입니다.',
  'dashboard.footnote':
    '주제와 주 단위로 집계했습니다. 개인별 활동은 표시하지 않습니다. 2명 미만이 물어본 주제는 “기타”로 묶었습니다.',
  'dashboard.topic.tooltip': { other: '{label}: 질문 {count}건, 그중 {answered}건 답변 — “{representative}”' },
  'dashboard.doc.tooltip': {
    other: '{label}: {count}회 검색됨, 그중 {unanswered}회는 답변이 부족했음 (최근 {week})',
  },
  'dashboard.meter.aria': '{percent} 답변',
  'dashboard.weekly.empty': '이 기간에는 아직 질문이 없습니다.',
  'dashboard.weekly.aria': '주별 질문 수',
  'dashboard.weekly.tooltip': { other: '{week}: 질문 {count}건, 그중 {answered}건 답변' },
  'dashboard.hbars.empty': '아직 보여줄 내용이 없습니다.',
  'dashboard.legend.answered': '답변함',
  'dashboard.legend.unanswered': '답변 못 함',
  'dashboard.hbars.tooltip': '{label}: {value}',
  'dashboard.gaps.empty': '이 기간에는 드러난 문서의 빈틈이 없습니다. 🎉',
  'dashboard.gaps.badge': '답변 못 함 {count}건',
  'dashboard.gaps.searched': '찾아봤지만 부족했던 문서:',

  // ── Google Docs sync ────────────────────────────────────────────────────
  'gdocs.sync.replaceWarning':
    '선택한 Google 문서의 내용이 이 문서로 대체되고, 이후 GitHub 기준으로 동기화됩니다. 계속할까요?',
  'gdocs.sync.error.link': '문서를 연결하지 못했습니다',
  'gdocs.sync.error.picker': '파일 선택기를 열지 못했습니다',
  'gdocs.sync.confirm.unlink': '이 문서의 Google Docs 동기화를 중단할까요? Google 문서 자체는 그대로 남습니다.',
  'gdocs.sync.error.unlink': '문서 연결을 해제하지 못했습니다',
  'gdocs.sync.button.fix': 'Docs 동기화 복구',
  'gdocs.sync.button.review': 'Docs 편집 검토',
  'gdocs.sync.title.awaitingManualApply':
    '이 문서는 자체 서식을 유지하므로, CHOIR의 변경 사항을 누군가 Google Docs에서 직접 반영해야 합니다',
  'gdocs.sync.title.drifted': '누군가 Google 문서를 편집했고, 관리자가 그 변경을 검토하고 있습니다',
  'gdocs.sync.title.preserve': 'Google 문서를 엽니다. CHOIR는 이 문서에 쓰지 않습니다',
  'gdocs.sync.title.replica': 'Google Docs 사본을 엽니다',
  'gdocs.sync.link.label': 'Google 문서',
  'gdocs.sync.button.unlink': '연결 해제',
  'gdocs.sync.title.broken': 'Google 연결이 만료되었습니다 — 다시 연결하면 동기화가 이어집니다',
  'gdocs.sync.title.connect': '이 문서를 Google 문서로 발행하고 GitHub 기준으로 동기화합니다',
  'gdocs.sync.button.busy': '처리 중…',
  'gdocs.sync.button.reconnect': 'Google 다시 연결',
  'gdocs.sync.button.sync': 'Google Docs로 동기화',

  // ── Google Docs review ──────────────────────────────────────────────────
  'gdocs.review.conflict.codeBlock':
    '이 편집은 코드 블록을 건드립니다. Google Docs에는 코드 블록이 없어서, 변경이 코드를 향한 것인지 주변 글을 향한 것인지 내보내기로는 알 수 없습니다.',
  'gdocs.review.conflict.unmappable': '이 글에 대응하는 부분이 저장소 문서에 없어서 안전하게 넣을 자리가 없습니다.',
  'gdocs.review.conflict.merge': '저장소와 Google Docs가 같은 곳을 바꿨습니다. 아래에는 저장소 쪽 내용을 남겼습니다.',
  'gdocs.review.status.noChange': 'Google 문서에 바뀐 내용이 없습니다.',
  'gdocs.review.status.notLinked': '이 문서는 Google 문서와 연결되어 있지 않습니다.',
  'gdocs.review.status.notConnected': '워크스페이스의 Google 계정이 연결되어 있지 않습니다.',
  'gdocs.review.status.notDrifted': '이 문서에는 검토를 기다리는 Google Docs 편집이 없습니다.',
  'gdocs.review.status.baselineLost':
    '이 문서의 비교 기준 스냅샷이 없어서 어떤 편집이 있었는지 계산할 수 없습니다. 연결을 해제했다가 다시 연결하면 처음부터 시작합니다.',
  'gdocs.review.error.load': '검토 내용을 불러오지 못했습니다',
  'gdocs.review.error.stale': '검토하는 동안 무언가 바뀌었습니다. 아래 제안을 새로 고쳤습니다.',
  'gdocs.review.error.approve': '변경을 승인하지 못했습니다',
  'gdocs.review.error.reject': '변경을 거절하지 못했습니다',
  'gdocs.review.confirm.rebaseline': 'Google 문서를 GitHub 버전으로 대체할까요? 문서에 쓰인 내용은 모두 사라집니다.',
  'gdocs.review.error.republish': '다시 발행하지 못했습니다',
  'gdocs.review.heading': 'Google Docs 편집',
  'gdocs.review.baselineLost.help':
    'GitHub에서 다시 발행하면 비교 기준 스냅샷이 새로 만들어지고 동기화가 다시 시작됩니다. {warning}, 남길 만한 내용은 먼저 복사해 두세요.',
  'gdocs.review.baselineLost.warning': '현재 Google 문서에 있는 내용은 모두 대체됩니다',
  'gdocs.review.button.republish': 'GitHub에서 다시 발행',
  'gdocs.review.button.openDoc': '문서 열기',
  'gdocs.review.editedBy': '{editor} 님이 편집했습니다.',
  'gdocs.review.editorUnknown': '편집한 사람을 확인할 수 없습니다.',
  'gdocs.review.approveHint':
    '승인하면 GitHub에 커밋하고 사본을 다시 발행합니다. 거절하면 변경을 버리고 사본을 원래대로 되돌립니다.',
  'gdocs.review.conflicts.count': { other: '{count}곳은 자동으로 반영하지 못했습니다' },
  'gdocs.review.conflicts.hint': '남길 만한 내용이 있다면 아래 제안을 직접 고치세요.',
  'gdocs.review.newAssets': { other: '이 변경과 함께 새 이미지 {count}개가 커밋됩니다.' },
  'gdocs.review.rejectedAssets': { other: '이미지 {count}개가 제외되었습니다: {reasons}.' },
  'gdocs.review.diff.identical': '제안이 저장소 내용과 정확히 같습니다.',
  'gdocs.review.label.proposal': '제안된 문서',
  'gdocs.review.button.approve': '승인 후 커밋',
  'gdocs.review.button.reject': '거절하고 사본 되돌리기',

  // ── Google Docs import ──────────────────────────────────────────────────
  'gdocs.import.prompt': '"{name}" 문서를 저장소에 다음 경로로 가져옵니다:',
  'gdocs.import.thisDocument': '이 문서',
  'gdocs.import.error.path': '.md로 끝나는 저장소 기준 상대 경로를 입력하세요',
  'gdocs.import.error.failed': '문서를 가져오지 못했습니다',
  'gdocs.import.error.interrupted': '가져오기가 끝나기 전에 멈췄습니다',
  'gdocs.import.rejectedAssets': { other: '가져왔지만 이미지 {count}개는 제외되었습니다:\n{reasons}' },
  'gdocs.import.button.importing': '가져오는 중…',
  'gdocs.import.button.import': 'Google Docs에서 가져오기',
  'gdocs.import.aria.progress': 'Google Docs 가져오기',
  'gdocs.import.starting': '가져오기를 시작하는 중…',

  // ── Import progress steps ───────────────────────────────────────────────
  'import.step.checking': '저장소를 확인하고 있어요',
  'import.step.reading': 'Google 문서를 읽고 있어요',
  'import.step.committing': 'GitHub에 커밋하고 있어요',
  'import.step.mirroring': '로컬 사본을 갱신하고 있어요',
  'import.step.linking': 'Google 문서를 연결하고 있어요',
  'import.step.done': '완료',

  // ── Google Picker ───────────────────────────────────────────────────────
  'picker.error.gapiMissing': 'Google API 스크립트를 불러왔지만 gapi가 없습니다',
  'picker.error.scriptFailed': 'Google 파일 선택기를 불러오지 못했습니다',
  'picker.error.start': '파일 선택기를 열지 못했습니다',
  'picker.error.unavailable': 'Google 파일 선택기를 사용할 수 없습니다',

  // ── Asset upload ────────────────────────────────────────────────────────
  'assets.error.upload': '업로드에 실패했습니다 ({status})',
  'assets.error.missingPath': '업로드 응답에 경로가 없습니다',

  // ── Docs API error codes ────────────────────────────────────────────────
  'serverError.internal_error': '서버에 문제가 생겼어요.',
  'serverError.unauthorized': '접근 권한이 없어요.',
  'serverError.forbidden': '허용되지 않는 요청이에요.',
  'serverError.not_signed_in': '로그인이 필요해요.',
  'serverError.workspace_mismatch': '지금 로그인한 워크스페이스와 맞지 않아요.',
  'serverError.not_a_manager': '워크스페이스 매니저만 할 수 있어요.',
  'serverError.manager_access_required': '매니저 권한이 필요해요.',
  'serverError.document_path_required': '문서 경로가 필요해요.',
  'serverError.file_path_required': '문서 경로(filePath)가 필요해요.',
  'serverError.content_required': '본문(content)이 필요해요.',
  'serverError.commit_message_required': '커밋 메시지(commitMessage)가 필요해요.',
  'serverError.file_path_and_file_id_required': '문서 경로(filePath)와 파일 ID(fileId)가 모두 필요해요.',
  'serverError.file_path_and_content_required': '문서 경로(filePath)와 본문(content)이 모두 필요해요.',
  'serverError.confirm_path_mismatch': '입력한 경로가 이 문서와 달라요.',
  'serverError.not_markdown_document': '마크다운 문서만 삭제할 수 있어요.',
  'serverError.expected_image_body': '이미지 파일이 담긴 요청이어야 해요.',
  'serverError.invalid_language': '지원하지 않는 언어예요.',

  // ── Settings dialog ───────────────────────────────────────────────────────
  'settings.title': '설정',
  'settings.aria.dialog': '설정',
  'settings.aria.open': '설정',
  'settings.mine.label': '내 언어',
  'settings.mine.hint': 'CHOIR가 나에게 말할 때 쓰는 언어예요. 이 화면과 Slack에 모두 적용돼요.',
  'settings.workspace.label': '워크스페이스 언어',
  'settings.workspace.hint': '멤버가 따로 설정하지 않았을 때 CHOIR의 메시지와 버튼에 쓰는 기본 언어예요.',
  'settings.content.label': '문서 작성 언어',
  'settings.content.hint':
    "CHOIR가 새 문서 내용을 쓸 때 사용하는 언어예요. '대화 언어를 따라가요'를 고르면 지금과 똑같이 동작해요.",
  'settings.option.auto': '자동 (Slack 언어를 따라가요)',
  'settings.option.followConversation': '대화 언어를 따라가요',
  'settings.button.save': '저장',
  'settings.button.saving': '저장하는 중…',
  'settings.error.save': '설정을 저장하지 못했어요. 다시 시도해 주세요.',
  'serverError.document_not_found': '문서를 찾을 수 없어요.',
  'serverError.record_not_found': '기록을 찾을 수 없어요.',
  'serverError.read_only_document': '이 문서는 읽기 전용으로 표시돼 있어요. 삭제하려면 앱 홈에서 먼저 해제해 주세요.',
  'serverError.write_access_denied': '워크스페이스 저장소에 쓰기 권한이 없어요.',
  'serverError.no_github_repo': '이 워크스페이스에는 아직 연결된 GitHub 저장소가 없어요.',
  'serverError.github_no_token': '{repo}를 편집하려면 CHOIR 앱 홈에서 GitHub 계정을 연결해 주세요.',
  'serverError.github_repo_is_archived': '{repo} 저장소가 GitHub에서 보관 처리돼 있어서 편집할 수 없어요.',
  'serverError.github_repo_read_only':
    'GitHub 계정이 {repo}에 읽기 전용으로만 접근할 수 있어요. 저장소 관리자에게 Write 권한을 요청한 뒤 이 페이지를 새로고침해 주세요.',
  'serverError.github_repo_not_visible':
    'GitHub 계정이 {repo}를 볼 수 없어요. 저장소 관리자에게 접근 권한을 요청한 뒤 이 페이지를 새로고침해 주세요.',
  'serverError.github_credentials_rejected':
    '{target}에 {action} 작업을 하려는데 GitHub가 저장된 인증 정보를 거절했어요. CHOIR 앱 홈에서 GitHub 계정을 다시 연결한 뒤 시도해 주세요.',
  'serverError.github_rate_limited':
    '{target}에 대한 {action} 요청이 GitHub의 요청 한도에 걸렸어요. 잠시 기다렸다가 다시 시도해 주세요.',
  'serverError.github_oauth_app_restricted':
    '{owner} 조직이 CHOIR의 GitHub OAuth 앱을 아직 승인하지 않아서 {target}에 {action} 작업을 할 수 없어요. 조직 소유자가 {url} 에서 승인해 주어야 해요.',
  'serverError.github_sso_required':
    '{owner} 조직의 SAML 싱글 사인온에 GitHub 인증이 연결돼 있지 않아서 CHOIR가 {target}에 {action} 작업을 할 수 없어요. GitHub 계정 설정의 "Authorized OAuth Apps"에서 인증한 뒤 다시 시도해 주세요.',
  'serverError.github_repo_archived':
    '{repo} 저장소가 보관됐거나 읽기 전용이라 CHOIR가 {target}에 {action} 작업을 할 수 없어요.',
  'serverError.github_write_forbidden':
    '연결된 계정으로는 {target}에 {action} 작업을 할 수 없다고 GitHub가 거절했어요.',
  'serverError.github_write_forbidden_detail':
    '연결된 계정으로는 {target}에 {action} 작업을 할 수 없다고 GitHub가 거절했어요. GitHub가 알려준 이유는 이래요: {detail}',
  'serverError.github_no_push_access':
    '{target}에 {action} 작업을 하려 했더니 GitHub가 404로 답했어요. GitHub는 쓰기 권한이 없을 때도 404로 답하기 때문에, 연결된 GitHub 계정에 {repo} 푸시 권한이 없을 가능성이 커요. 저장소 관리자에게 Write 권한을 요청하거나, 권한이 있는 계정으로 CHOIR 앱 홈에서 GitHub를 다시 연결해 주세요.',
  'serverError.github_target_not_found':
    '{target}을(를) 찾지 못했어요. 이 워크스페이스에 설정된 저장소와 브랜치, 파일 경로를 확인해 주세요.',
  'serverError.github_branch_moved':
    'CHOIR가 {target}에 쓰는 동안 브랜치가 움직여서 {action} 작업이 충돌로 거절됐어요. 문서를 새로 불러온 뒤 변경을 다시 적용해 주세요.',
  'serverError.github_branch_protected':
    'GitHub가 {target}에 대한 {action} 작업을 거절했어요. 풀 리퀘스트를 요구하는 보호된 브랜치인 경우가 가장 흔해요.',
  'serverError.github_branch_protected_detail':
    'GitHub가 {target}에 대한 {action} 작업을 거절했어요. 풀 리퀘스트를 요구하는 보호된 브랜치인 경우가 가장 흔해요. GitHub가 알려준 이유는 이래요: {detail}',
  'serverError.github_unavailable':
    'GitHub에 연결할 수 없어서(HTTP {status}) {target}에 대한 {action} 작업이 반영되지 않았어요. 잠시 후 다시 시도해 주세요.',
  'serverError.image_too_large': '10MB보다 큼',
  'serverError.too_many_images': '한 번에 추가한 새 이미지가 너무 많음',
  'serverError.unsupported_image_type': 'PNG, JPEG, GIF, WebP 이미지가 아님',
  'serverError.google_not_connected': 'Google 계정을 먼저 연결해 주세요.',
  'serverError.google_picker_not_configured':
    '파일 선택기가 설정돼 있지 않아요 (GOOGLE_PICKER_API_KEY, GOOGLE_PROJECT_NUMBER).',
  'serverError.google_no_access_token': 'Google이 액세스 토큰을 주지 않았어요.',
  'serverError.google_pick_expired_link': '문서를 다시 골라 주세요. 이 연결 요청은 만료됐어요.',
  'serverError.google_pick_expired_import': '문서를 다시 골라 주세요. 이 가져오기 요청은 만료됐어요.',
  'serverError.google_doc_missing_in_repo': '이 워크스페이스에는 그런 문서가 없어요.',
  'serverError.google_doc_trashed': '그 문서는 휴지통에 있어요.',
  'serverError.google_doc_already_linked': 'Google 문서 {fileId}는 이미 {conflictPath}에 연결돼 있어요.',
  'serverError.google_doc_not_linked': '이 문서는 Google 문서와 연결돼 있지 않아요.',
  'serverError.github_document_gone': 'GitHub 문서가 더 이상 없어요. 대신 이 사본의 연결을 해제해 주세요.',
  'serverError.republish_failed': 'GitHub에서 이 문서를 다시 게시하지 못했어요: {message}',
  'serverError.review_declined_not_restored': '누군가 되돌리기 전까지는 거절된 내용이 문서에 그대로 남아 있어요.',
  'serverError.import_invalid_path': '.md로 끝나는 저장소 기준 경로를 적어 주세요.',
  'serverError.import_path_exists': '{path}는 이미 이 저장소에 있어요.',
  'serverError.import_empty': '그 문서는 내용이 빈 채로 내보내졌어요.',
  'serverError.import_failed': '문서를 가져오지 못했어요: {message}',
  'serverError.import_interrupted': '가져오기가 끝나기 전에 멈췄어요.',

  // ── Milkdown/Crepe editor chrome ────────────────────────────────────────
  'editor.placeholder': '내용을 입력하세요...',
  'editor.slash.group.text': '텍스트',
  'editor.slash.text': '본문',
  'editor.slash.h1': '제목 1',
  'editor.slash.h2': '제목 2',
  'editor.slash.h3': '제목 3',
  'editor.slash.h4': '제목 4',
  'editor.slash.h5': '제목 5',
  'editor.slash.h6': '제목 6',
  'editor.slash.quote': '인용',
  'editor.slash.divider': '구분선',
  'editor.slash.group.list': '목록',
  'editor.slash.bulletList': '글머리 기호 목록',
  'editor.slash.orderedList': '번호 매기기 목록',
  'editor.slash.taskList': '체크리스트',
  'editor.slash.group.advanced': '고급',
  'editor.slash.image': '이미지',
  'editor.slash.codeBlock': '코드',
  'editor.slash.table': '표',
  'editor.slash.math': '수식',
  'editor.image.uploadButton': '파일 올리기',
  'editor.image.uploadButtonInline': '올리기',
  'editor.image.confirmButton': '확인',
  'editor.image.captionPlaceholder': '이미지 설명을 입력하세요',
  'editor.image.uploadPlaceholder': '또는 링크를 붙여넣기',
  'editor.link.placeholder': '링크를 붙여넣으세요...',
  'editor.code.searchPlaceholder': '언어 검색',
  'editor.code.noResult': '결과 없음',
  'editor.code.copy': '복사',
  'editor.code.previewLabel': '미리보기',
  'editor.code.previewLoading': '불러오는 중...',
  'editor.code.previewEdit': '편집',
  'editor.code.previewHide': '숨기기',
};
