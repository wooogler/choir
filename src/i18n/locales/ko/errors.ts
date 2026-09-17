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

  'errors.llm.noApiKey': 'OpenAI API 키가 없어요. 앱 홈에서 등록하거나 OPENAI_API_KEY 환경 변수를 설정해 주세요.',
} as const;
