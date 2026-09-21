# 프로젝트 폴더 — 폴더 · Slack 채널 · 검색 범위를 한 단위로

> 상태: **PF1~PF4 구현 완료 (2026-09-21)**. 아래 "구현 현황"이 코드와 계획의 차이를 적는다.

## 구현 현황 (2026-09-21)

- `services/projects/` — `schema.ts`(검증·직렬화, 알 수 없는 키 거부), `project-index.ts`(미러 스캔, 60초 TTL, `resolveProjectForPath`/`resolveProjectForChannel`), `project-store.ts`(커밋 + 미러 + 무효화), `slack-directory.ts`(채널·멤버, 10분 캐시, `missing_scope` → `slack_scope_missing`), `routes.ts`. 라우트는 `app.ts`의 `registerProjectRoutes`로 등록되며 oauth 모드에서는 설치 저장소에서 워크스페이스별 봇 토큰을 읽는다.
- **미러는 git clone이 아니라 GitHub API로 받은 파일 집합**이라, `.choir/project.json`을 별도로 가져오는 `services/sync/project-file-sync.ts`를 두었다(트리에서 `<folder>/.choir/project.json`만 골라 미러에 쓰고, 전체 동기화 때 사라진 것을 지운다). `.choir/context/**`는 의도적으로 제외.
- 검색 범위: `RetrievalSearchParams.scope` + `services/retrieval/scope.ts`(순수), QMD 제공자는 4배(최대 50) 과다 조회 뒤 적용. `widened`는 새 선택 메서드 `searchWithMeta`로 노출된다. Slack 질문 경로(`question-processor.ts`, 6번째 인자 `channelId`)만 연결됐고 뷰어 Q&A는 미연결.
- 갱신 범위: `services/document/update-scope.ts`. 채널→범위 해석은 `suggest-updates-handler.ts`와 `update-request-handler.ts` 두 곳에서만. 폴더에 후보가 없으면 전체로 넓히고 DM에 한 줄 안내. 새 파일 경로 검증이 폴더를 허용하도록 바뀌었다(세그먼트별 검사).
- 읽기 전용 목록은 `folder/` 항목을 접두로 해석한다. App Home 선택기가 폴더 항목을 제공한다.
- App Home Documents 탭의 프로젝트 목록은 읽기 전용이고 "설정" 버튼은 뷰어 루트를 연다 — 뷰어에 폴더 딥링크가 없다.
- 뷰어 GUI: `ProjectSettingsDialog.tsx`(기본·채널·멤버·범위·용어집 탭), 사이드바 폴더에 "P" 배지와 hover 톱니. 멤버 탭은 저장 전 선택을 반영하기 위해 채널별 멤버 API를 합쳐 쓴다.
- `groups:read`는 매니페스트·기본 스코프에 추가됐고, 설치된 워크스페이스는 재승인이 필요하다.
- 미착수: 프로젝트별 QMD 컬렉션, 뷰어 Q&A·대시보드의 프로젝트 선택기, App Home의 회의록 폴더·용어집 파일명 설정(기본값 사용).

## 한 문장

저장소의 폴더 하나를 **프로젝트**로 선언하면, 그 폴더에 **어느 Slack 채널이 속하는지**가 메타데이터로 남고, 그 채널에서 오는 질문·대화는 **그 폴더를 우선 범위로** 검색·갱신되며, 회의록의 참석자는 **그 채널의 멤버**에서 온다. 메타데이터는 마크다운 편집기가 아니라 **전용 GUI**로 고친다.

## 왜 폴더인가

지금 CHOIR는 저장소 전체가 하나의 범위다. 워크스페이스에 프로젝트가 여럿이면 세 가지가 어긋난다.

1. **검색 잡음.** 프로젝트 A 채널에서 물었는데 B의 문서가 답에 섞인다. 같은 용어("배포", "실험 설정")가 프로젝트마다 다른 뜻이다.
2. **갱신 대상 오류.** A 채널의 대화에서 뽑은 지식이 B의 문서에 제안된다. 새 문서를 만들 때 어느 폴더에 둘지 매번 묻는다.
3. **사람 관리 중복.** 참석자·역할을 문서(`PEOPLE.md`)로 따로 유지하려 했지만, 그 사람들은 이미 Slack 채널에 있다. 채널 멤버가 진실이고, 문서는 사본이 된다.

폴더는 이미 저장소에 있는 구조이고, 관리자가 이미 그렇게 나눠 쓴다. 새 개념을 만들지 않고 폴더에 이름표를 붙인다.

## 결정 (제안)

### 1. 메타데이터는 폴더 안의 `.choir/project.json`

```
projects/alpha/
  .choir/project.json     ← 프로젝트 메타데이터 (GUI가 쓴다)
  GLOSSARY.md             ← 프로젝트 용어집 (문서, 인덱싱됨)
  meetings/
    2026-09-20-weekly.md
  design.md
```

- **폴더 안에 두는 이유**: 폴더를 옮기거나 이름을 바꾸면 메타데이터가 따라간다. 저장소를 다른 CHOIR 인스턴스에 연결해도 프로젝트 구조가 유지된다(서버의 `data/`에 두면 둘 다 안 된다). 버전이 남는다.
- **`.choir/`인 이유**: 이미 예약된 이름이다 — 뷰어 트리에 나오지 않고, `normalizeDocumentPath`가 문서로 취급하지 않으며, import 경로 검증이 거부한다. 루트의 `.choir/context/`(provenance)와 같은 관례.
- **JSON인 이유**: GUI가 읽고 쓰는 데이터다. 사람이 손으로 고치는 문서는 `GLOSSARY.md`처럼 마크다운으로 두고, 설정은 기계 형식으로 둔다. 스키마 검증이 쉽고 오타로 깨지지 않는다.
- **Slack 채널 ID는 저장소에 들어간다.** 채널 ID(`C0123…`)는 비밀이 아니지만, 저장소가 공개라면 "이 조직에 이런 채널이 있다"는 사실은 드러난다. 멤버 목록은 **저장하지 않고 Slack에서 실시간으로 읽는다**. 별칭(받아쓰기 교정용)은 Slack 사용자 ID를 키로 저장하고 이름은 저장하지 않는다 — GUI가 이름을 실시간으로 붙인다.

```jsonc
{
  "version": 1,
  "name": "Alpha",
  "description": "실험 플랫폼 재설계. 2026 하반기.",
  "channels": ["C0AB12CD3", "C0EF45GH6"],
  "members": {
    // "channels": 연결된 채널의 (봇 아닌) 멤버 전부가 프로젝트 멤버
    // "curated": 아래 목록만
    "source": "channels",
    "curated": ["U01AAA", "U02BBB"],
    // 받아쓰기 교정·화자 라벨 매핑용. 키는 Slack 사용자 ID, 값은 표기들.
    "aliases": { "U01AAA": ["상욱님", "Sangwook", "Speaker 1"] }
  },
  "scope": {
    // 이 프로젝트 채널에서 온 질문의 검색 범위
    "retrieval": "boost",        // "boost" | "exclusive" | "off"
    // 이 프로젝트 채널의 대화에서 뽑은 문서 갱신 제안의 대상
    "updates": "folder"          // "folder" | "workspace"
  },
  "meetingsFolder": "meetings",  // 회의록 기본 폴더 (프로젝트 폴더 기준 상대 경로)
  "glossary": "GLOSSARY.md"      // 기본값. 다른 이름을 쓰면 여기서 바꾼다
}
```

### 2. 채널 → 프로젝트 해석

- **한 채널은 한 프로젝트에만** 속한다. GUI가 다른 프로젝트에 이미 연결된 채널은 비활성으로 보이고, 서버가 저장 시 거부한다.
- **한 프로젝트는 여러 채널**을 가질 수 있다(개발 채널 + 논문 채널).
- 프로젝트 폴더는 중첩될 수 있다. 문서 경로에서 프로젝트를 찾을 때는 **가장 가까운 상위 폴더**의 것(용어집 체인과 같은 규칙).
- 연결되지 않은 채널(일반 잡담, DM)에서 온 질문은 지금처럼 **저장소 전체**를 본다. 루트는 프로젝트가 아니다.
- 기존의 `qaChannel` 설정(질문을 받는 채널)은 그대로 둔다. 서로 다른 축이다 — 그 채널이 어느 프로젝트에 속하는지는 이 문서의 매핑이 정한다.

`services/projects/project-index.ts`: 미러에서 `**/.choir/project.json`을 찾아 `{ folder → Project }`와 `{ channelId → folder }`를 만든다. 미러 동기화(GitHub webhook·주기 sync·뷰어 저장) 뒤에 무효화. `resolveProjectForChannel(ws, channelId)`, `resolveProjectForPath(ws, path)`, `listProjects(ws)`.

### 3. 검색 범위 (Q&A)

질문이 채널 C에서 왔고 C가 프로젝트 P(폴더 F)에 속하면:

| `scope.retrieval` | 동작 |
| --- | --- |
| `boost` (기본) | 전체를 검색하되 F 아래 문서의 점수를 올린다. 답에 F 밖의 문서가 섰으면 인용에 폴더가 보이므로 사용자가 안다 |
| `exclusive` | F 아래 + 저장소 루트의 문서(README, 루트 용어집 등 깊이 0)만. 결과가 없거나 임계값 아래면 **전체로 넓혀 다시 찾고 답에 "프로젝트 문서에는 없어 전체에서 찾았습니다"를 한 줄 붙인다** |
| `off` | 지금과 같음 |

구현: `RetrievalSearchParams`에 `scope?: { pathPrefixes: string[]; mode: 'boost' | 'exclusive' }`를 더한다. QMD는 워크스페이스당 `docs` 컬렉션 하나이고 경로 필터가 없으므로, **`limit`의 4배를 받아 `metadata.fileName` 접두로 후처리**한다(boost는 순위 재조정, exclusive는 필터 + 부족 시 재검색). 인메모리 벡터 스토어는 접두 필터가 곧바로 된다. 프로젝트별 QMD 컬렉션은 성능이 문제가 될 때의 다음 단계다.

호출부: `QuestionProcessor`(Slack 질문)와 뷰어의 Q&A가 채널 ID → 프로젝트 → `scope`를 넘긴다. 답변 프롬프트에는 프로젝트 `description`과 **프로젝트 용어집 블록**이 들어간다(`organizationDescription`이 들어가는 자리).

### 4. 갱신 범위 (문서 업데이트 제안)

채널 C의 대화에서 지식을 뽑아 문서 갱신을 제안할 때, `scope.updates === 'folder'`면:

- 후보 문서 검색(`similaritySearchWritableFiles`, `QmdUpdateAnchorService.search`)을 F 아래로 제한한다. 읽기 전용 목록 필터는 그대로.
- "새 문서 만들기"의 기본 폴더가 F가 된다(지금은 루트).
- 지식 추출 프롬프트에 프로젝트 설명 + 용어집 블록.
- 후보가 없으면 지금처럼 새 문서를 제안하되, 폴더는 F.

`workspace`면 지금과 같다. 기본값은 `folder` — 프로젝트를 선언했다는 것 자체가 "이 채널 이야기는 여기 문서다"라는 뜻이다.

### 5. 사람은 Slack에서

- 프로젝트 멤버 = 연결된 채널들의 멤버 합집합에서 봇 제외 (`conversations.members`, 페이지네이션, `users.info`로 봇 여부·표시 이름 — 기존 `name-cache.ts` 재사용). `members.source === 'curated'`면 `curated` 목록만.
- 채널 멤버는 서버 메모리에 **채널별 10분 캐시**. 저장소에는 쓰지 않는다.
- **회의록 만들기**의 참석자 기본값 = 회의록이 들어갈 폴더의 프로젝트 멤버. 큰 채널이면 `curated`로 줄인다. 화자 라벨 매핑·익명화 별칭은 `members.aliases`. `PEOPLE.md`는 **만들지 않는다** — `docs/meeting-notes-and-glossary.md` 3b는 이 절로 대체된다.
- 필요한 Slack 권한: 공개 채널은 지금 있는 `channels:read`로 충분. **비공개 채널은 `groups:read`가 필요**하고 봇이 그 채널에 초대돼 있어야 한다. 스코프 추가와 워크스페이스 재승인은 관리자(사용자)가 Slack 앱 설정에서 직접 한다(2026-09-20 확인). 코드 쪽은 PF1에서 `DEFAULT_SLACK_SCOPES`와 `manifest.example.json`·`manifest.dev.json`에 `groups:read`를 추가한다. 스코프가 아직 없는 워크스페이스에서는 GUI가 비공개 채널을 "권한 없음"으로 표시하고 공개 채널만 연결한다.

### 6. GUI — 뷰어 안의 프로젝트 설정

Block Kit(App Home)은 다중 선택·표 편집에 맞지 않는다. 뷰어(React)에 만든다.

- 사이드바의 폴더 항목에 hover 시 톱니 아이콘 → **프로젝트 설정 대화상자**. 프로젝트가 아닌 폴더에는 "이 폴더를 프로젝트로 만들기".
- 대화상자 탭:
  - **기본** — 이름, 설명(Q&A 프롬프트에 들어간다고 안내), 회의록 폴더.
  - **채널** — 봇이 볼 수 있는 채널 목록(`conversations.list`, 공개 + 봇이 속한 비공개)에서 다중 선택. 다른 프로젝트에 연결된 채널은 비활성 + 어느 프로젝트인지 표시. 아카이브된 채널은 경고.
  - **멤버** — 연결 채널의 멤버 표(아바타·이름·Slack 직함). "핵심 멤버만" 토글(`curated`)과 체크박스, 사람마다 **별칭** 입력(받아쓰기 교정용이라고 안내).
  - **범위** — 검색 범위(boost/exclusive/off)와 갱신 범위(folder/workspace) 라디오, 각 선택의 뜻을 한 문장으로. 이 폴더를 읽기 전용으로(기존 `readOnlyFiles`에 폴더 접두로 추가 — 지금은 파일명 기준이라 접두 지원이 필요).
  - **용어집** — 이 폴더의 `GLOSSARY.md` 상태(있음/없음, 항목 수). 없으면 "용어집 만들기"(회의록 설계 3a의 흐름) 버튼.
- 저장 → `PUT /api/docs/:ws/projects/<folder>` → 스키마 검증 → 채널 중복 검사 → `.choir/project.json`을 **GitHub에 커밋**(`commitFilesWithContext`, 메시지 `Update project settings: <folder>`) → 미러 쓰기 → 프로젝트 인덱스 무효화. 인증 사다리는 문서 저장과 같다(관리자 + push 권한).
- 채널·멤버 목록은 `GET /api/docs/:ws/slack/channels`, `GET /api/docs/:ws/slack/channels/:id/members`(서버가 봇 토큰으로 Slack을 호출, 관리자만).
- App Home의 Documents 탭에는 **프로젝트 목록을 읽기 전용으로** 보여주고 각 항목의 "설정" 버튼이 뷰어 GUI를 연다("Open Docs" 버튼과 같은 패턴). Slack에서 편집하지 않는다.

### 7. 저장 형식과 안전

- `.choir/project.json`은 뷰어의 문서 저장 경로(`saveEditedDocument`)를 타지 않는다 — 문서가 아니라 provenance·인덱스·replica가 다 무관하다. `services/projects/project-store.ts`가 `commitFilesWithContext` + 미러 쓰기만 한다.
- 스키마 검증(`zod` 없이 손으로, 기존 코드 스타일): 알 수 없는 키 거부, 채널 ID 형식(`^[CG][A-Z0-9]+$`), 사용자 ID 형식, `meetingsFolder`는 `..` 없는 상대 경로.
- 손으로 고쳐 깨진 JSON은 인덱스에서 건너뛰고 GUI에 "파일이 깨져 있습니다 — 다시 저장하면 덮어씁니다"로 보인다.
- GitHub 쪽 독자에게는 `.choir/project.json`이 보인다. README에 한 줄: "`.choir/`는 CHOIR의 메타데이터입니다."

## Non-goals

- 프로젝트별 권한(누가 어느 폴더를 편집할 수 있는지). 관리자 모델은 워크스페이스 단위로 둔다.
- 프로젝트별 QMD 컬렉션. 후처리 필터로 시작한다.
- 채널 멤버 변화를 저장소에 기록. 실시간 조회만.
- Slack 쪽에서 메타데이터 편집.

## 단계

| 단계 | 내용 | 기간 |
| --- | --- | --- |
| PF1 | `services/projects/`(스키마·인덱스·store·채널 해석), `GET/PUT projects`, Slack 채널·멤버 조회 라우트 + 캐시, `groups:read` 스코프 추가와 배포 노트 | 1일 |
| PF2 | 뷰어 GUI: 폴더 톱니 → 프로젝트 설정 대화상자(기본·채널·멤버·범위·용어집), App Home 읽기 전용 목록 | 1.5일 |
| PF3 | 검색 범위: `RetrievalSearchParams.scope`, QMD 후처리 boost/exclusive + 전체 재검색, `QuestionProcessor`·뷰어 Q&A 연결, 프롬프트에 설명·용어집 | 1일 |
| PF4 | 갱신 범위: 후보 검색 제한, 새 문서 기본 폴더, 지식 추출 프롬프트, `readOnlyFiles` 폴더 접두 지원 | 1일 |
| — | 회의록 만들기(M1~)는 PF1 위에서 참석자를 프로젝트 멤버로 받는다 | (회의록 문서) |

## 열어둔 질문

1. `exclusive`에서 "루트 문서 포함"을 기본으로 둘지. 제안: 포함 — README·루트 용어집·조직 규정은 어느 프로젝트에서도 답의 근거가 된다.
2. 프로젝트가 아닌 폴더의 회의록은 참석자를 어디서 채울지. 제안: 비워 두고 최근 회의록의 참석자만 자동완성. 프로젝트로 만들라는 안내 한 줄.
3. 뷰어 Q&A(있다면)와 대시보드에 "현재 프로젝트" 선택기를 둘지. 제안: 후속 — 먼저 채널 기반 자동 범위만.
