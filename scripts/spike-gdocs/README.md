# Spike: GitHub → Google Docs 복제본 동기화

GitHub을 source of truth로 두고 Google Docs를 **읽기 전용 복제본**으로 발행하는 설계의
미확인 항목을 실측하기 위한 스파이크입니다. 제품 코드가 아니며 어디에도 연결되어 있지 않습니다.

## 왜 이 방향이 쉬운가

CHOIR가 문서를 *직접 생성*하므로 `drive.file` 스코프면 충분합니다. Google이 이를
**non-sensitive**로 분류하므로 restricted scope 검증도, 연간 CASA 보안 심사도 불필요합니다.
양방향 연동에서는 `drive.readonly`(restricted)가 필요해 이 관문에 걸립니다.

복제본은 파생물이라 "전체 내용 교체"가 정확한 의미론이고, 따라서 Docs API의
`batchUpdate` 인덱스 매핑 레이어가 전혀 필요 없습니다. blame/provenance도 GitHub에
그대로 남습니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `fixture.md` | 변환 위험 요소를 모아둔 테스트 픽스처 (중첩 목록·표·코드 블록·원격 이미지) |
| `spike-common.ts` | 공용: 루프백 OAuth(토큰 캐시), 마크다운 export, 스냅샷 비교, base64 정규화 |
| `drive-spike.ts` | P0 체크 9종 — 폴더 생성 / 문서 생성 / **내용 교체 시 fileId 유지** / **version 펜스** / **export 멱등성** / 메타데이터 변경의 version 영향 / 권한 / 목록. 기본은 마크다운 import, `--html`로 HTML 경로 |
| `picker-spike.ts` | P0 체크 — **Picker로 고른 남의 문서에 서버측(refresh token만으로) 접근이 되는지**. 로컬 페이지를 띄워 실제 Picker를 사용 |
| `markdown-to-docs-html.ts` | HTML import 경로용 렌더러 (`marked` 재사용). **측정 결과 마크다운 import가 우세해 기본 경로에서는 불필요** — 코드 블록 우선이면 사용 |
| `render.ts` | 위 렌더러로 마크다운 파일을 HTML로 렌더 |
| `docs-spike.ts` | **P0-C 체크 12종 — 서식 보존 in-place 편집이 가능한지.** `files.copy` / `documents.get`(관문) / `batchUpdate` 인가 / `fields` 마스크 / **풍부한 서식 문서의 export 결정성** / batchUpdate의 Drive version 영향 / **revision 펜스** / 문단 비우고 다시 채웠을 때 스타일 유지 / 삽입 앵커 규칙 / 구조 인벤토리 |

## GCP 준비 (P0 실행 전 1회)

[console.cloud.google.com](https://console.cloud.google.com) 에서:

1. **프로젝트 생성** (기존 것 재사용 가능). 좌측 상단 프로젝트 선택 → 새 프로젝트.
2. **API 사용 설정** — "APIs & Services" → "Enable APIs and Services" 에서 두 개를 켭니다:
   - **Google Drive API** (필수)
   - **Google Picker API** (검증 B에만 필요)
3. **OAuth consent screen** — External / Testing으로 두고, **Test users에 본인 Google 계정을
   추가**합니다. Testing 모드에서는 심사 없이 test user만 사용할 수 있어 스파이크에 충분합니다.
   스코프는 화면에서 추가하지 않아도 됩니다(스크립트가 요청).
4. **OAuth 클라이언트 ID** — "Credentials" → "Create credentials" → "OAuth client ID" →
   Application type **Desktop app** → 생성 후 **JSON 다운로드**. 이 파일 경로가
   `GOOGLE_OAUTH_CLIENT` 입니다.
5. (검증 B만) **API 키** — "Create credentials" → "API key". 스파이크 동안은 제한 없이 두고,
   끝나면 삭제하거나 Picker API로 제한하십시오. 이 값이 `GOOGLE_PICKER_API_KEY` 입니다.
6. (검증 B만) **프로젝트 번호** — 콘솔 대시보드 "Project info"의 *Project number*(숫자).
   Project **ID**(문자열)가 아닙니다. 이 값이 `GOOGLE_PROJECT_NUMBER` 입니다.

주의: Picker의 `setAppId`는 프로젝트 번호이고 **OAuth 클라이언트와 같은 프로젝트**여야
per-file grant가 앱에 붙습니다. 다르면 검증 B가 조용히 실패합니다.

첫 실행 시 인가 URL이 콘솔에 출력됩니다. 브라우저에서 열어 승인하면
`scripts/spike-gdocs/.drive-spike-token.json`(0600, gitignore됨)에 refresh token이 캐시되어
이후에는 다시 묻지 않습니다. 검증이 끝나면 이 파일을 지우십시오.

**브라우저가 다른 머신에 있을 때**(원격 체크아웃의 일반적인 경우): 승인 후
`http://127.0.0.1:<포트>`로 리디렉션되면서 브라우저는 연결 실패를 표시합니다 — 정상입니다.
주소창 URL을 통째로 복사해 스파이크가 띄운 `Paste the redirect URL (or just the code) here:`
프롬프트에 붙여넣으면 됩니다. 스파이크는 루프백 수신과 stdin 붙여넣기를 동시에 기다리므로
어느 쪽이든 먼저 오는 것을 씁니다. **중간에 Ctrl-C를 누르면 인가 코드가 무효화되니** 프롬프트가
뜬 상태로 두십시오.

## 실행

레포의 ts-node는 현재 이 스크립트를 직접 실행하지 못합니다(아래 "알려진 환경 문제"). 직접 컴파일합니다:

```bash
pnpm spike:gdocs
```

`pnpm build`(그리고 이를 포함하는 `pnpm verify`)가 `rm -rf dist`를 하므로 그 뒤에는
`pnpm spike:gdocs`를 다시 돌려야 합니다. 토큰 캐시는 `scripts/spike-gdocs/`에 있어 살아남습니다.

렌더만:

```bash
node dist-spike/render.js scripts/spike-gdocs/fixture.md dist-spike/fixture.html
```

### P0 검증 A — Drive 동작 (자격증명 1개)

```bash
GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json node dist-spike/drive-spike.js --keep
```

체크 9종이 PASS/FAIL로 출력됩니다. 설계상 가장 중요한 것은:

- **4. replace content in place** — fileId/URL이 유지되어야 함 (복제본 URL 안정성의 전제)
- **5. version fence** — `files.update` 응답의 `version`이 직후 `files.get`과 일치해야 함.
  불일치하거나 응답에 `version`이 없으면 publisher의 펜스를 get-before/after로 바꿔야 함
- **3 / 6. export 멱등성** — 같은 내용이 항상 같은 markdown으로 export되어야 함.
  실패 시 base64 이미지 페이로드만 흔들리는지(정규화로 해결 가능) 아닌지를 함께 보고

`--html`을 붙이면 마크다운 대신 HTML import 경로로 같은 검증을 돌립니다.
첫 export 원문은 `dist-spike/export-sample.md`에 저장되어 눈으로 확인할 수 있습니다.

### P0 검증 B — Picker per-file grant (자격증명 3개)

"기존 Doc 선택" UX의 전제를 검증합니다. 브라우저가 아니라 **서버가 refresh token만으로**
그 문서에 접근되는지를 봅니다(3분 폴러가 며칠 뒤에 하는 일과 동일).

```bash
GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json \
GOOGLE_PICKER_API_KEY=... \
GOOGLE_PROJECT_NUMBER=... \
node dist-spike/picker-spike.js
```

**브라우저가 다른 머신에 있을 때는 포트 포워딩이 필요합니다.** 아래 명령은 **브라우저가 도는
머신(예: 노트북)에서** 실행해야 합니다 — CHOIR 서버에서 실행하면 자기 자신으로 가는 터널이
생기면서 5599를 점유해 스파이크가 뜨지 못합니다:

```bash
ssh -L 5599:127.0.0.1:5599 <user>@<choir-host>
```

포트가 이미 잡혀 있으면 `PORT=5600 node dist-spike/picker-spike.js`처럼 바꿀 수 있습니다.

출력된 `http://127.0.0.1:5599`를 열고 Doc을 고르면 콘솔과 페이지에 결과가 찍힙니다.

⚠️ **반드시 본인이 직접 만든 문서를 고르십시오.** `drive.file` 스코프는
"앱이 만든 파일 **+** Picker로 사용자가 열어준 파일" 양쪽을 커버하므로, `drive-spike.ts`가
만든 문서(`CHOIR replica spike…`)를 고르면 Picker grant와 무관하게 모든 체크가 통과해
**아무것도 증명하지 못합니다.** 스파이크가 이 경우를 감지해 `INCONCLUSIVE`로 보고합니다. 쓰기 검증은 기본이 **이름 변경 후 복원**(비파괴)이며,
`--allow-write`를 붙이면 내용 교체까지 검증합니다 — 이 경우 고른 문서의 내용이 **삭제**되므로
반드시 버려도 되는 문서로 하십시오.

## 실측 결과 (2026-08-31)

측정 도구가 중요합니다. Drive MCP 커넥터의 `read_file_content`는 손실적인 "자연어 표현"이라
서식 판정에 쓸 수 없습니다. **`download_file_content` + `exportMimeType: text/markdown`**
(즉 Docs의 마크다운 export)이 정확한 계측기이고, 아래 결과는 전부 이쪽 기준입니다.

첫 측정에서 `read_file_content`로 내린 판정 중 **중첩 목록 평탄화 / 이미지 누락 / 표 헤더 손상 /
취소선 손실 / 인라인 코드 손실은 모두 오판**이었습니다. 실제로는 전부 보존됩니다.

### 결론: 마크다운 직접 import가 낫습니다

같은 픽스처를 두 경로로 올려 왕복시킨 비교입니다.

| 항목 | HTML import | **마크다운 import** |
| --- | --- | --- |
| 헤딩 → Docs 개요 | 잡히나 `# **제목**`으로 굵게 중복 | **`# 제목` 깔끔** |
| 목록 | **인용문 안으로 들어감** (`> * 항목`) | **`- 항목` 정상** |
| 중첩 목록 (2/3단계) | 들여쓰기는 유지되나 위 오염 | **완벽** |
| 순서 목록 + 중첩 | — | **완벽** |
| 인용문 | **소실** (일반 문단) | **`>` 보존** |
| 수평선 | **소실** | **`---` 보존** |
| 표 | 보존 | 보존 |
| 이미지 (원격 URL) | 보존 | **보존** |
| 굵게 / 기울임 / 링크 / 취소선 / 인라인 코드 | 보존 | 보존 |
| 한글 | 정상 | 정상 |
| **코드 블록** | **우세** — 줄마다 monospace로 왕복 | 들여쓰기는 남지만 평문이 되고 줄 사이 빈 줄이 낌 |

코드 블록 하나를 빼면 마크다운 import가 전부 우세합니다. 그리고 **마크다운 import를 쓰면
이 디렉터리의 HTML 렌더러 자체가 불필요합니다** — GitHub의 원본 마크다운을 그대로 올리고
이미지 상대경로만 절대 URL로 바꾸면 됩니다.

### 정정: 마크다운 import는 이미지를 깨뜨리지 않습니다

처음에 "마크다운 import는 이미지를 base64 data URL로 바꿔 깨뜨린다"고 판단해 HTML import를
택했는데, 이는 **방향을 잘못 읽은 것**이었습니다. data URL이 되는 건 Docs → 마크다운 *export*
쪽 현상이고, 마크다운 → Docs *import* 방향에서는 원격 URL 이미지를 Drive가 정상적으로
가져와 임베드합니다 (alt 텍스트 포함). 두 경로 모두 동일하게 동작합니다.

### 코드 블록 세부

HTML import에서 세 가지 마크업을 비교한 결과는 여전히 유효합니다:

| 마크업 | 결과 |
| --- | --- |
| `<p style="white-space:pre-wrap">` | Drive가 CSS `white-space`를 무시 |
| `<p>` + `<br>` + `&nbsp;` | 줄바꿈은 되나 들여쓰기가 **nbsp(U+00A0)** — 복붙 시 깨짐 |
| **`<pre>`** | 줄바꿈 + **진짜 공백** 들여쓰기 보존 |

마크다운 import 경로를 택하더라도 코드 블록 표현이 아쉽다면, 발행 후 코드 블록 구간에만
`documents.batchUpdate`로 monospace를 입히는 후처리를 고려할 수 있습니다.

### 남은 손실 (양쪽 공통, 감내 가능)

- 코드 블록의 언어 라벨(```` ```typescript ````)은 어느 쪽에서도 의미를 갖지 못합니다.
- Docs 표에는 헤더 행 개념이 없어 헤더 강조가 사라집니다.

### P0 검증 A 결과 (2026-08-31, 9/9 PASS)

`drive.file` 스코프만으로, My Drive 기준:

| 체크 | 결과 |
| --- | --- |
| 1. 폴더 생성 | PASS |
| 2. 마크다운 import | PASS (version=4) |
| 3. **export 반복 시 byte 동일** | PASS — 7379 bytes 완전 일치 (**base64 이미지 페이로드 포함**) |
| 4. **내용 교체 시 fileId 유지** | PASS — fileId·URL 불변 |
| 5. **version 펜스** | PASS — `files.update` 응답 version=6 == 직후 `files.get` version=6 |
| 6. **동일 내용 재push → 동일 export** | PASS — 7409 bytes 완전 일치 |
| 7. 메타데이터 변경의 version 영향 | 이름 변경만으로 7→8 **증가함** |
| 8. 권한 설정(anyone/reader) | PASS |
| 9. app-created 파일 목록 | PASS |

**결론: baseline 3-way merge의 전제가 성립합니다.** Docs의 마크다운 export 직렬화는
결정적이며(3·6), base64 이미지 인코딩까지 안정적이라 정규화 레이어가 필요 없습니다.
publisher는 `files.update` 응답의 version을 그대로 펜스로 쓸 수 있습니다(5).
7은 계획이 이미 가정한 대로 — version은 **트리거**일 뿐이고 진실 판정은
export-vs-baseline이어야 함을 확인해 줍니다.

### export가 바꾸는 것 (델타 추출이 다뤄야 할 노이즈)

같은 내용이면 노이즈가 양쪽에서 상쇄되지만, **사람이 새로 쓴 줄**은 export 문법을 달고
들어옵니다. 실측된 변형:

| 원본 | export 결과 |
| --- | --- |
| ` ```ts … ``` ` | **펜스 소실** — 줄마다 별도 문단 + 사이에 빈 줄, `\[`·`\=` 이스케이프 |
| `## 1. 제목` | `## 1\. 제목` (숫자 뒤 마침표 이스케이프) |
| 목록 항목 | 줄 끝에 하드 브레이크용 공백 2개 |
| 인용문 2줄 | 한 문단으로 병합 |
| 표 구분선 `---` | `:----` (정렬 마커 부가) |
| `![alt](url)` | `![alt][image1]` + 문서 끝에 `[image1]: <data:image/png;base64,…>` |

따라서 P4의 델타는 **추가/변경된 헝크에 한해 역이스케이프·트레일링 공백 제거**를 거쳐야
GitHub 마크다운에 그대로 커밋해도 지저분하지 않습니다. 코드 블록은 계획대로 충돌 승격.

### P0 검증 B 결과 (2026-08-31, GRANT CONFIRMED)

앱이 만들지 않은 문서(10일 전 사용자가 직접 생성)를 Picker로 선택한 뒤,
**refresh token만 보유한 새 OAuth 클라이언트**로 서버측에서:

| 체크 | 결과 |
| --- | --- |
| 0. refresh token만으로 액세스 토큰 발급 | PASS |
| 1. `files.get` | PASS (version=276, created=2026-08-21) |
| 2. `files.export` 마크다운 | PASS (11478 bytes) |
| 3. 쓰기(이름 변경 후 복원) | PASS |
| 4. 내용 교체 | SKIP — `--allow-write` 필요 |

**결론: Picker per-file grant는 서버측에서 지속됩니다.** "사용자가 기존 Doc을 고르면 그 뒤로
CHOIR가 계속 동기화한다"는 P1 UX가 성립합니다.

**체크 4도 이후 `--allow-write`로 확인했습니다** — 고른 문서의 **내용 교체**가 되고 fileId도
유지됩니다. P1의 첫 동작(고른 Doc을 GitHub 버전으로 교체)이 성립합니다.

부수 발견: **빈 Google Doc은 0바이트로 export됩니다.** 따라서 빈 export는 실패가 아니라
"문서가 비었음"이라는 정상 결과이며, 드리프트 판정에서 `baseline 파일 없음`(측정 불가)과
`baseline이 빈 문자열`(사람이 내용을 전부 지움)을 반드시 구분해야 합니다.

### P0-C 검증 — 서식 보존 in-place 편집 (미실행)

`docs/gdocs-format-preserving-sync.md`의 Phase B 착수 게이트입니다. **합성 픽스처가 아니라
실제 Handbook에 대고 돌려야 합니다** — 도형·커스텀 폰트·소프트 줄바꿈은 픽스처에 없습니다.

GCP 콘솔에서 **Google Docs API를 추가로 켜야** 합니다(Drive API만으로는 체크 1이 403).

```bash
GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json \
  node dist-spike/docs-spike.js --file-id <documentId> --keep
```

스파이크는 지정한 문서를 **`files.copy`로 복사한 뒤 사본에만 씁니다.** 원본은 어떤 경로로도
수정되지 않습니다(`--no-copy`를 명시했을 때만 예외). `--keep`을 주면 사본을 남겨 눈으로
확인할 수 있고, 없으면 끝에 삭제합니다.

체크 12종:

| 체크 | 무엇을 결정하는가 |
| --- | --- |
| 0. `files.copy` | Phase A의 백업 수단. 동일 충실도 복원은 native copy뿐 |
| **1. `documents.get`** | **관문.** Picker grant가 Docs API에도 미치는지. 실패 시 민감 스코프로 가지 말고 Phase A에서 멈춘다 |
| 2. `batchUpdate` 인가 | 아무것도 바꾸지 않는 배치로 쓰기 권한만 확인 |
| 3. `fields` 마스크 | import 시점의 탭 사전 점검을 싸게 할 수 있는지 |
| **4. export 결정성 ×3** | 드리프트 판정 전체의 전제. 지금까지 CHOIR가 만든 문서로만 측정됨 |
| 5. version 영향 | batchUpdate가 Drive `version`을 올리는지 — 폴러의 유일한 트리거 |
| 6. revision 펜스 | 낡은 `requiredRevisionId`가 400으로 거부되는지 |
| **7a. 스팬 교체** | 바뀐 문자 구간만 교체했을 때 **주변 run(링크·기울임·굵게)이 그대로인지**. "스타일은 두고 텍스트만" 의 가장 강한 형태. 실제 Handbook 제목처럼 run이 섞인 문단이어야 의미가 있다 |
| 7b. 삽입 후 삭제 | 개행 직전에 새 텍스트를 넣고 옛 텍스트를 지웠을 때 문단 스타일·폰트가 유지되는지 |
| 7c. 삭제 후 삽입 | 옛 텍스트를 먼저 지우고 문단 시작에 넣었을 때 **앞 문단의 스타일이 새어 들어오는지** |
| 8. 삽입 앵커 | `endIndex - 1`은 되고 body 끝 인덱스는 안 되는지. 섹션 추가가 가능한지가 여기서 갈린다 |
| 9. 구조 인벤토리 | 표·이미지·위치 고정 개체·소프트 줄바꿈·탭이 몇 개인지, export 줄과 문단이 1:1로 대응하는지 |

체크 9는 PASS/FAIL이 아니라 **눈으로 읽는 출력**입니다. 문단 목록과 export 앞부분을 나란히
찍어 주므로, 가운데 정렬 서명줄이 Shift+Enter로 만든 한 문단인지 세 문단인지 같은 것이
거기서 드러납니다. export 원문은 `docs-spike-export.md`로 저장됩니다.

### 아직 미검증

- 위 P0-C 체크 12종 (스크립트는 준비됨, 실행 필요)
- 공유 드라이브(shared drive)에서 위가 모두 되는지 — 조직 전체 공유가 목표라면 실질 관문
  (`drive-spike.js --shared-drive <driveId>`)

### 실측에 쓴 문서

- [spike 2 — 변형별 테스트](https://docs.google.com/document/d/1SwS2urcgUB4l42moO_c1_OZ71anUjgBoMbykr9TSJNM/edit)
- [spike 3 — HTML import (변환기 출력)](https://docs.google.com/document/d/1zcl5hARZze7m9kRK9CfnWjjXD3M9-DdJ5MHZMbX4BEg/edit)
- [spike 4 — 마크다운 직접 import](https://docs.google.com/document/d/13afXjlhHXoQa-QgjCgkdd26imd-UXvP44wKt6L16xwI/edit)

## 알려진 환경 문제

`ts-node`가 이 레포에서 동작하지 않습니다. TypeScript 6 + `moduleResolution: node10` 조합에서
`@types/node`를 못 찾고(TS2591), `transpileOnly`로도 `rootDir` 미지정 오류(TS5011)가 납니다.
`npx ts-node -e "import fs from 'node:fs'"` 만으로 재현되며 이 스파이크와 무관한 선재 문제입니다.

`tsc`(`pnpm build`)와 `jest`(`pnpm test`)는 정상입니다. 다만 `pnpm dev:socket`, `dev:oauth`,
`backfill:dashboard`, `migrate:sqlite`, `purge:workspace-cache`가 모두 `ts-node`를 쓰므로
동일하게 막혀 있을 것으로 보입니다.
