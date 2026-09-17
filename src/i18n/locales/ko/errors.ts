/**
 * Korean for the failures a person can act on.
 *
 * These are read at the worst moment, so each one ends with what to do next
 * rather than only what went wrong — 해요체 throughout, like the rest of the
 * bot. The English originals are terse ("File already exists"); the Korean is
 * allowed to be a full sentence, because a bare noun phrase reads like a
 * system dump rather than an answer.
 *
 * `OPENAI_API_KEY` stays in Latin letters: it is an environment variable name
 * the reader has to type exactly.
 */

export const errors = {
  'errors.unknown': '알 수 없는 오류가 생겼어요. 잠시 후 다시 시도해 주세요.',

  'errors.github.privateRepoUnsupported': '비공개 저장소는 지원하지 않아요. 공개 저장소를 골라 주세요.',
  'errors.github.writeAccessRequired':
    '이 저장소를 연결하려면 쓰기 권한이 필요해요. 권한을 받은 뒤 다시 시도해 주세요.',
  'errors.github.fileAlreadyExists': '같은 이름의 파일이 이미 있어요. 다른 이름을 지어 주세요.',
  'errors.github.concurrentModification':
    '{path} 파일을 다른 사람이 먼저 수정해서, 덮어쓰지 않으려고 커밋을 멈췄어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.',
  'errors.github.deviceCodeExpired': '기기 인증 코드가 만료됐어요. 처음부터 다시 연결해 주세요.',
  'errors.github.authorizationDenied': 'GitHub 연결 요청이 거절됐어요. 다시 연결하려면 처음부터 진행해 주세요.',
  'errors.github.authorizationTimeout': '인증을 기다리는 시간이 지났어요. 처음부터 다시 연결해 주세요.',

  // 쓰기 실패. {action}은 영어 동사('update', 'commit', 'upload')라서 '{action}
  // 작업'처럼 명사로 받아 적었고, {target}과 {repo}는 저장소·경로 식별자라 그대로
  // 뒀어요. {url}은 조직 정책 페이지 주소로, 카탈로그가 아니라 호출부에서 와요.
  'errors.github.credentialsRejected':
    '{target}에 {action} 작업을 하려는데 GitHub가 저장된 인증 정보를 거절했어요. CHOIR 앱 홈에서 GitHub 계정을 다시 연결한 뒤 시도해 주세요.',
  'errors.github.rateLimited':
    '{target}에 대한 {action} 요청이 GitHub의 요청 한도에 걸렸어요. 잠시 기다렸다가 다시 시도해 주세요.',
  'errors.github.oauthAppRestricted':
    '{owner} 조직이 CHOIR의 GitHub OAuth 앱을 아직 승인하지 않아서 {target}에 {action} 작업을 할 수 없어요. 조직 소유자가 {url} 에서 승인해 주어야 해요.',
  'errors.github.ssoRequired':
    '{owner} 조직의 SAML 싱글 사인온에 GitHub 인증이 연결돼 있지 않아서 CHOIR가 {target}에 {action} 작업을 할 수 없어요. GitHub 계정 설정의 "Authorized OAuth Apps"에서 인증한 뒤 다시 시도해 주세요.',
  'errors.github.repoArchived':
    '{repo} 저장소가 보관됐거나 읽기 전용이라 CHOIR가 {target}에 {action} 작업을 할 수 없어요.',
  'errors.github.writeForbidden': '연결된 계정으로는 {target}에 {action} 작업을 할 수 없다고 GitHub가 거절했어요.',
  'errors.github.writeForbiddenDetail':
    '연결된 계정으로는 {target}에 {action} 작업을 할 수 없다고 GitHub가 거절했어요. GitHub가 알려준 이유는 이래요: {detail}',
  'errors.github.noPushAccess':
    '{target}에 {action} 작업을 하려 했더니 GitHub가 404로 답했어요. GitHub는 쓰기 권한이 없을 때도 404로 답하기 때문에, 연결된 GitHub 계정에 {repo} 푸시 권한이 없을 가능성이 커요. 저장소 관리자에게 Write 권한을 요청하거나, 권한이 있는 계정으로 CHOIR 앱 홈에서 GitHub를 다시 연결해 주세요.',
  'errors.github.targetNotFound':
    '{target}을(를) 찾지 못했어요. 이 워크스페이스에 설정된 저장소와 브랜치, 파일 경로를 확인해 주세요.',
  'errors.github.branchMoved':
    'CHOIR가 {target}에 쓰는 동안 브랜치가 움직여서 {action} 작업이 충돌로 거절됐어요. 문서를 새로 불러온 뒤 변경을 다시 적용해 주세요.',
  'errors.github.branchProtected':
    'GitHub가 {target}에 대한 {action} 작업을 거절했어요. 풀 리퀘스트를 요구하는 보호된 브랜치인 경우가 가장 흔해요.',
  'errors.github.branchProtectedDetail':
    'GitHub가 {target}에 대한 {action} 작업을 거절했어요. 풀 리퀘스트를 요구하는 보호된 브랜치인 경우가 가장 흔해요. GitHub가 알려준 이유는 이래요: {detail}',
  'errors.github.unavailable':
    'GitHub에 연결할 수 없어서(HTTP {status}) {target}에 대한 {action} 작업이 반영되지 않았어요. 잠시 후 다시 시도해 주세요.',

  'errors.llm.noApiKey': 'OpenAI API 키가 없어요. 앱 홈에서 등록하거나 OPENAI_API_KEY 환경 변수를 설정해 주세요.',
} as const;
