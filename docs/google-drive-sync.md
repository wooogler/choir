# Google Drive Sync — GitHub ↔ Google Docs 복제·승인 환류 계획

GitHub을 source of truth로 유지하면서 문서별로 Google Docs 복제본을 연결하고,
Docs에서 발생한 사람 편집을 **관리자 승인을 거쳐** GitHub에 반영하는 기능의 구현 계획.
이 문서는 구현 세션이 단독으로 읽고 실행할 수 있도록 작성되었다. 구현 전 `CLAUDE.md`와
선행 스파이크 `scripts/spike-gdocs/README.md`(변환 품질 실측 결과)를 먼저 읽을 것.
본문 내 코드 참조는 계획 시점(2026-08-31) 기준으로 검증되었다.

**빌드 순서: P0 → P1 → P2 → P3 → P4.** P0은 스파이크 확장(검증), P1부터가 제품 코드다.

---

## 확정된 설계 결정 (재논의 불필요)

| 결정 | 내용 |
|---|---|
| 원본 | GitHub이 source of truth. Google Docs는 접근성용 복제본 |
| 반영 수준 | **B: 복제 + 승인 환류.** Docs의 사람 편집은 자동 커밋하지 않고, 델타를 추출해 관리자 승인 후 GitHub에 커밋 |
| 계정 모델 | **워크스페이스당 Google 계정 1개.** 관리자가 웹 뷰어에서 1회 연결. 모든 Drive API 호출은 이 계정의 refresh token으로 수행 |
| OAuth 스코프 | `drive.file` 단일 스코프(non-sensitive → restricted-scope 심사·CASA 불필요). 기존 문서 선택은 Google Picker의 per-file grant 이용 — Picker에 `setAppId`(GCP **프로젝트 번호**, OAuth 클라이언트와 같은 프로젝트) 필수 |
| 변환 경로 | GitHub→Docs push는 `text/markdown` 직접 import(실측상 HTML보다 우세 — 스파이크 README). 감지·델타는 Docs의 markdown export(`files.export`, `text/markdown`) |
| 변경 감지 | **폴링**(기본 3분, `files.get` fields=`version,modifiedTime`). `files.watch`는 채널 1일 만료 + HTTPS 콜백 요구로 채택하지 않음. 네이티브 Docs에는 `headRevisionId`가 없으므로 단조 증가 `version`을 사용 |
| 루프 방지 | CHOIR가 push할 때 **version을 펜스로 관측**(아래 P2). version 증가는 **트리거**일 뿐이고, `export ≠ baseline`이 **진실 판정**(메타데이터 변경으로 인한 version 증가 오탐 흡수) |
| 델타 추출 | **baseline 3-way merge.** push 직후의 export를 baseline으로 저장 → 사람 편집 감지 시 `diff3(base=baseline, theirs=현재 export, ours=현재 GitHub markdown)`. 양쪽 스냅샷이 같은 변환기를 통과했으므로 변환 노이즈가 상쇄되고 사람의 델타만 남는다 |
| 동시성 | **문서(workspace, path)당 in-process async mutex** 하나로 publish / poll-check / approve / reject를 전부 직렬화. 폴러는 이전 런이 끝나지 않았으면 해당 틱을 건너뜀. 전제 조건: **하나의 data 디렉터리는 정확히 한 프로세스가 소유**(PM2 다중 인스턴스는 워크스페이스가 아니라 배포 단위로 분리되어 있음 — 이 불변식을 어기는 배포 금지) |
| 파괴적 전이 규칙 | 카드 버튼·API의 모든 결정은 저장된 상태에 대한 **compare-and-swap**(상태 + 매핑 존재 + auth 유효 + `reviewedVersion` 일치)을 통과해야 실행. 불일치 시 "already handled" 응답. 복원·재push 등 Docs를 덮어쓰는 동작은 **version 펜스**를 두 번 확인 |
| 승인 UX | 새 PR 인프라를 만들지 않는다(레포에 PR 생성 코드 없음). 기존 Slack 관리자 알림 패턴을 **복제**(재사용 가능한 공용 헬퍼는 없음 — 아래 P3)하고 웹 뷰어에 리뷰 화면 추가 |
| UI 언어 | Slack/웹/Docs 배너 등 사용자 노출 문구는 영어(기존 제품 언어) |

### Non-goals — 만들지 말 것

- 자동 양방향 동기화(승인 없는 커밋 금지 — CHOIR의 "문서 변경은 관리자가 승인" 모델 유지)
- 저장소 전체 폴더 트리 미러링(매핑은 문서 단위, 뷰어에서 문서별로 연결)
- Docs 전용 서식(글자색·폰트·배치)의 보존 — markdown에 표현이 없으므로 조용히 소실되는 것을 허용
- `drive`/`drive.readonly` 등 restricted 스코프 사용
- Docs revisions API 기반의 정합성(리비전은 자동 통합·삭제됨 — 공식 문서 명시. 참고 정보로만 사용)
- SVG 이미지의 저장소 반입(아래 P4 보안 — 래스터만 허용)

---

## 동작 모델

문서별 상태 기계 (매핑 하나당):

```
linked(synced) ──사람 편집 감지──▶ drifted ──관리자 검토 시작──▶ pending-review
     ▲                                │                             │
     │◀── GitHub 반영 커밋 + 재push(승인, ours 펜스 통과) ◀────────┤
     │◀── 복제본 복원 재push(거절, version 펜스 통과) ◀────────────┘
                    (별도 종단 상태: baseline-lost, orphaned, error)
```

- **synced**: 복제본 = GitHub 최신. GitHub 변경 시 즉시 push(내용 해시 변경분만).
- **drifted**: 폴러가 사람 편집 감지(version 증가 그리고 export ≠ baseline). 이 문서에 대한
  GitHub→Docs push는 **보류**(사람 편집을 덮어쓰지 않기 위해). 관리자에게 Slack 알림.
- **pending-review**: 델타 추출 완료, 관리자 검토 중. 승인 → `commitFilesWithContext`로 커밋
  (+provenance) 후 **force 재push**(P2) → synced. 거절 → force 재push(복원)만 → synced.
  검토 중 Docs가 또 바뀌면(version > `reviewedVersion`) 델타 재추출 + 카드 갱신.
- **baseline-lost**: baseline 파일 유실/손상. 자동 재push 금지(사람 편집을 덮어쓸 수 있음).
  `base := ours`의 열화된 2-way diff로 리뷰만 가능, 해소는 관리자 결정으로만.
- **orphaned**: GitHub 쪽 원본이 삭제/이동됨. Doc은 삭제하지 않고 배너를
  *"The source document was removed from GitHub."*로 교체, 관리자 알림(relink or unlink).

pending-review에서의 이탈 전이(모두 CAS로 보호):

- `DELETE /link`(unlink) → 카드 무효화(전 관리자 카드를 "unlinked by @X"로 갱신) 후 매핑 제거.
- `disconnect` → 카드 무효화 후 auth 제거. **승인 처리 순서는 항상 auth·매핑 검증 → 커밋 →
  재push** (커밋 후 재push가 auth 부재로 실패하는 반쪽 상태 방지).
- GitHub 원본 삭제 → orphaned로 전이, 카드에 반영. 승인으로 파일을 부활시키지 않는다
  (델타는 폐기 가능하도록 Docs 내용 export를 카드에 첨부).

루프 방지·편집자 식별의 한계: 우리가 워크스페이스 연결 계정(관리자의 refresh token)으로 쓰기
때문에, 그 계정 본인의 수동 편집과 CHOIR의 push는 `lastModifyingUser`로 구분되지 않는다.
구분은 오직 version 펜스로 한다. **다른 사용자**의 편집은 `lastModifyingUser`에 남으므로
승인 카드·provenance에 편집자 표시용으로만 활용(보장 아님).

---

## 데이터 모델

**`WorkspaceConfig`에 추가** — `services/workspace/workspace-store.ts`. config 전체가
`encryptJson`으로 암호화 저장되므로 별도 암호화 불필요. `mutateConfigSync`는 `protected`이므로
**새 접근자는 WorkspaceStore 클래스 안에** 둔다(기존 `saveUserGithubToken` 패턴, :799-812):

```ts
google?: {
  auth?: {
    refreshToken: string;
    email?: string;          // 연결된 Google 계정 (표시용)
    connectedBy: string;     // Slack userId
    connectedAt: Date;
    broken?: boolean;        // invalid_grant 등으로 재연결 필요 표시
  };
  docs?: {
    [githubPath: string]: {
      fileId: string;
      webViewLink: string;
      linkedBy: string;      // Slack userId
      linkedAt: Date;
    };
  };
};
```

접근자: `setGoogleAuth` / `getGoogleAuth` / `clearGoogleAuth` / `setGoogleDocMapping` /
`removeGoogleDocMapping` / `getGoogleDocMappings`. 같은 `fileId`의 중복 매핑은 세터에서 거부.
폴러의 워크스페이스 열거는 기존 `getAllWorkspaceConfigs()`(:932)로 시작하고, 부하가 보이면
id-only `listWorkspaceIds()`를 추가(최적화).

**동기화 북키핑** (비밀 아님 — `data/workspaces/<id>/state/`, 기존 sync-state/path-map 패턴.
state/ 하위 첫 서브디렉터리이므로 서비스가 직접 mkdir):

```jsonc
// state/gdocs-sync.json — 경로별
{
  "state": "synced|drifted|pending-review|baseline-lost|orphaned|error",
  "lastPushedVersion": "…",        // P2의 펜스로 관측된 값만 기록
  "lastPushedContentHash": "…",
  "lastPushedAt": "…",
  "driftDetectedAt": "…",
  "lastModifyingUser": "…",        // 참고 정보
  "reviewedVersion": "…",          // 카드/리뷰 화면이 렌더된 시점의 Doc version (거절 펜스)
  "oursBlobSha": "…",              // 델타 추출 시점의 GitHub 블롭 SHA (승인 펜스)
  "reviewCards": [{ "managerId": "…", "channel": "…", "ts": "…" }],  // 재기동 후 카드 갱신용
  "error": "…"
}
// state/gdocs-baselines/<sha256(githubPath)>.md — push 직후 export 원문
```

**환경 변수** (`src/config`의 `AppConfig`에 `getGoogleConfig()` 추가, `.env.example`에 문서화):

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — **Web application** 타입
  (스파이크의 Desktop 타입과 다름). 리디렉션 URI `${DOCS_BASE_URL}/docs/auth/google/callback`
  을 GCP 콘솔에 등록
- `GOOGLE_PICKER_API_KEY` — Picker 로드용 developer key(HTTP referrer 제한 권장)
- `GOOGLE_PROJECT_NUMBER` — Picker `setAppId`용

---

## P0 — 남은 가정 검증 (검증 A 완료 2026-08-31: 9/9 PASS)

**검증 A 결과 — 설계 전제 전부 확인됨** (상세: `scripts/spike-gdocs/README.md`):
내용 교체 시 fileId·URL 유지, `files.update` 응답의 `version`이 직후 `files.get`과 일치
(펜스 그대로 사용 가능), 반복 export 및 동일 내용 재push가 **byte 단위로 동일**
(base64 이미지 페이로드 포함 — 정규화 레이어 불필요), 메타데이터 변경만으로도 version 증가
(계획대로 export-vs-baseline이 진실 판정이어야 함을 확인). **P1~P4를 그대로 진행 가능.**

**검증 B(Picker per-file grant)는 미완** — `picker-spike.ts`가 준비되어 있고 GCP의
Picker API + API 키 + 프로젝트 번호가 필요하다. 실패 시 P1의 "기존 Doc 선택"을
"CHOIR가 새 Doc 생성 + 폴더만 선택"으로 격하한다.

### 남은 스파이크 항목

`scripts/spike-gdocs/drive-spike.ts`의 기존 5개 체크(폴더 생성 / markdown import /
**내용 교체 시 fileId 유지** / 권한 / 공유 드라이브)에 더해:

1. **Export 멱등성**: import 직후 export를 두 번 받아 byte-diff = 0인지. 그리고 내용 교체 후
   재-export가 이전 baseline과 "사람 편집 없음" 판정을 낼 수 있는 형태인지.
   **3-way merge 설계 전체가 이 가정 위에 있다.** 멱등이 아니면(예: 이미지 base64 인코딩이
   비결정적) 어떤 정규화가 필요한지 기록.
2. **`version` 필드 거동**: 네이티브 Docs에서 files.get으로 조회되는지, `files.update` 응답의
   `fields=version`으로 관측 가능한지(P2 펜스의 전제), 내용 교체 시 증가하는지, 권한 변경 같은
   메타데이터 조작으로도 증가하는지(오탐 예상 범위 파악).
3. **Picker per-file grant 지속성**: 로컬 미니 페이지(Picker + `setOAuthToken` + `setAppId` +
   `setDeveloperKey`)로 스파이크가 만들지 않은 기존 문서를 선택 → 같은 OAuth 클라이언트의
   refresh token으로 **서버측** `files.get`/`files.export`/`files.update`가 되는지. 이것이
   되어야 "기존 문서 선택" UX가 성립한다(안 되면 P1을 "CHOIR가 새 Doc 생성 + 폴더만 선택"으로
   격하).

Exit criteria: 세 항목 모두 결과가 스파이크 README에 기록됨. 실패 항목은 이 문서의 해당
단계에 반영 후 진행.

## P1 — 연결 파이프라인: OAuth + Picker + 매핑 (1~2일)

선행: `@googleapis/drive`를 devDependencies에서 **dependencies로 승격**(현재는 스파이크용
devDep — 프로덕션 코드가 import하므로 필수).

새 피처 폴더 `services/google/`:

- `google-auth-service.ts` — 인가 URL 생성(`access_type=offline`, `prompt=consent`,
  scope=`drive.file`), 코드 교환, refresh token으로 access token 발급(만료 캐시),
  해제 시 `https://oauth2.googleapis.com/revoke` 호출. 실패 코드 `invalid_grant` →
  `google.auth.broken = true` 마킹.
- `drive-client.ts` — `@googleapis/drive` 래퍼: `importMarkdownAsDoc`, `replaceDocContent`
  (응답 `fields=version` 포함), `exportDocMarkdown`, `getDocMeta(version, modifiedTime,
  lastModifyingUser, trashed)`. 429/5xx 지수 백오프.
- `doc-lock.ts` — (workspaceId, path) 키의 async mutex + single-flight(동일 문서에 대한
  중복 publish 요청 병합). P2~P4 전체가 이 락 안에서 동작.

라우트 (`app.ts` `setupPublicSite()`, 기존 Slack OIDC 라우트와 같은 구획). **모든 라우트는
기존 패턴대로 `session.workspaceId === :ws`를 명시적으로 검사**(기존 write 라우트의 게이트와
동일 — 다른 워크스페이스 관리자의 호출 차단):

| 라우트 | 게이트 | 동작 |
|---|---|---|
| `GET /docs/auth/google/start?workspaceId=` | 세션 + `isManager` | state 쿠키(기존 `oauth-state.ts` 패턴 재사용) 후 Google로 리디렉션 |
| `GET /docs/auth/google/callback` | state 검증 | 코드 교환 → `setGoogleAuth` → 원래 문서로 리디렉션 |
| `GET /api/docs/:ws/google/status` | 세션 | `{connected, email, broken}` + 현재 문서의 매핑·상태 |
| `POST /api/docs/:ws/google/picker-token` | 세션 + `isManager` + ws 일치 | **단기(수 분)** access token + `{apiKey, projectNumber}` + 서버 발행 **picker nonce** 반환. 토큰은 클라이언트에 저장하지 않음 |
| `POST /api/docs/:ws/google/link` | 세션 + `isManager` + ws 일치 | body `{filePath, fileId, pickerNonce}`. **nonce가 최근 picker-token 발급분과 일치해야 수락**(임의 fileId로 과거 grant 문서를 파괴하는 것 방지). 서버가 `files.get` 검증 후 `setGoogleDocMapping` → **1회 push**(P2 publisher, force). 기존 Doc 내용이 GitHub 버전으로 대체됨을 응답에 명시 + 감사 로그 |
| `DELETE /api/docs/:ws/google/link` | 세션 + `isManager` + ws 일치 | CAS로 매핑 해제(pending-review면 카드 무효화 선행). Doc 자체는 삭제하지 않음 |
| `POST /api/docs/:ws/google/disconnect` | 세션 + `isManager` + ws 일치 | 열린 카드 전부 무효화 → 토큰 revoke → `clearGoogleAuth`. 매핑은 보존하되 전부 비활성 |

웹 (`web/src/`):

- `DocViewer.tsx`의 `headerRight`에 "Sync to Google Docs" 버튼(기존 `doc-button` 패턴,
  `isManager` 게이팅). 미연결 → OAuth start로 이동. 연결됨+미매핑 → Picker 오픈
  (`https://apis.google.com/js/api.js` 지연 로드; 기존 Doc 선택 또는 "Create new" 선택지).
  매핑됨 → Doc 링크 + "Unlink" 메뉴.
- 기존 Doc 선택 시 확인 다이얼로그(영어): *"The current content of this Google Doc will be
  replaced by the GitHub version."* — 서버측 nonce 검증이 실질 방어이고 다이얼로그는 UX.

## P2 — GitHub → Docs 복제 push (1일)

`services/google/replica-publisher.ts` — 문서 락 안에서:

```
publishReplica(workspaceId, path, content, { force })
  → force가 아니면: contentHash == lastPushedContentHash → skip
  → force가 아니면: state ∈ {drifted, pending-review, baseline-lost} → skip (사람 편집 보호)
  → 본문 전처리: 배너 1줄 prepend + 상대경로 이미지 → 공개 URL 재작성
  → files.update(text/markdown import, 응답 fields=version) … v0 관측
  → files.export(text/markdown) → baseline 후보
  → files.get(version) … v1 관측
  → v1 !== v0 이면: baseline 후보 폐기, 1회 재시도 → 재실패 시 state=drifted로 마킹
     (update~export 사이에 낀 사람 편집이 baseline에 흡수되어 영구 미감지되는 것 방지)
  → v1 === v0 이면: baseline 저장, lastPushedVersion=v1, 해시·시각 기록, state=synced
```

- **`force` 모드가 승인 후 재push와 거절 복원의 유일한 경로다.** force 없이 재push하면
  해시 가드(내용 불변)와 상태 가드(pending-review)에 걸려 no-op이 되는 함정이 있다.
  전이 순서는 항상 **push 성공 → state/baseline 갱신**, 역순 금지.
- 배너(영어, 상수): `*This document is a read-only replica of a GitHub document, synced by
  CHOIR. Edits made here are not applied directly — they are sent to a manager for review.*`
  델타 비교 전 제거는 **정확 일치가 아니라 구조 기준**: 문서 첫 줄이
  `/^\*This document is a read-only replica.*\*$/`(+ 배포 이력상 과거 배너 문구 목록)에
  걸리면 양쪽에서 제거. **배너 라인만의 델타는 드리프트가 아니라 "배너 복원 대상"으로 처리**
  (혼란한 사용자가 배너를 지우는 게 가장 흔한 편집 — 관리자 알림 없이 자동 복원).
- 이미지 재작성: `resolve-images.ts`의 기존 조각들(`classifyImageSrc`,
  `resolveLocalImageRepoPath`, `signImageToken`, URL 템플릿)을 재사용해 **작은 재작성 함수를
  새로 작성**(기존 `collectReplyImages`는 Slack 답변 블록용이라 드롭인 불가). Drive는 import
  시점에 이미지를 가져와 **사본을 임베드**하므로 토큰 30일 TTL은 무해. 단
  **`DOCS_BASE_URL`이 공인 HTTPS여야** Drive가 접근 가능(배포 전제).
- 훅 3곳 (기존 사이드이펙트 옆, 모두 fire-and-forget `void ...catch`; single-flight가 중복
  병합):
  1. `services/sync/github-sync-service.ts` — `scheduleQmdWarmup`/이미지 enrich 옆,
     `source !== 'startup'` 동일 게이팅. webhook/manual-refresh 경로 커버. 이 시점의
     `MarkdownFile[]`은 전체 파일 셋이므로 매핑된 경로만 필터.
  2. `services/docs-editor/save-document.ts` — 커밋 성공 후. 웹 편집은 자기 커밋이
     webhook에서 `[choir-auto]`로 스킵되어 1번 훅을 타지 않으므로 필수.
  3. **`services/github/document-updater.ts`** — `applyDocumentUpdatesToGithub()`의 파일별
     커밋 성공 지점(markGithubSyncSuccess 직후). Slack 문서 업데이트도 같은 이유로 필수.
     ⚠️ 이름이 비슷한 `services/document/document-update-service.ts`는 미러 스테이징만 하고
     커밋하지 않음 — 거기 걸면 안 됨. (Slack 새 파일 생성 커밋
     `create-file-submission.ts`는 방금 만든 파일이라 매핑이 있을 수 없어 훅 불요.)
- 실패는 로그 + `gdocs-sync.json`의 `error`에 기록(다음 트리거에서 해시 불일치로 자연 재시도).

## P3 — 편집 감지 + 보류 + 알림 (1일)

`services/google/drift-detector.ts` + `app.ts` 부트스트랩의 폴러
(기존 세션 스위퍼/토픽 클러스터링과 같은 `setInterval` + `.unref()` + per-run catch, 3분,
**이전 런 미완료 시 틱 스킵**):

```
각 워크스페이스(google.auth 있고 !broken) → 각 매핑 (문서 락 획득 후):
  files.get(version, modifiedTime, lastModifyingUser, trashed)
  → trashed → state=error, 관리자 알림("relink or unlink")
  → version == lastPushedVersion → 통과
  → version 증가 → files.export → 배너 규칙 적용 후 baseline과 비교
      → 동일 → lastPushedVersion만 갱신(메타데이터 변경 오탐)
      → 배너 라인만 상이 → 배너 자동 복원(force push, 알림 없음)
      → 상이 → state=drifted, reviewedVersion=현재 version 기록, 관리자 Slack 알림
  → baseline 파일 부재/손상 → state=baseline-lost, 관리자 알림(자동 재push 금지)
```

- **대량 드리프트 차단기**: 한 폴링 사이클에서 N개(예: 5) 이상의 문서가 동시에, 정규화/공백
  수준의 델타로 드리프트 판정되면 — Google이 export 직렬화를 서버측에서 바꾼 경우다 —
  관리자 DM을 보내지 않고 운영자 알림 1건으로 대체 + 폴링 일시 중지. baseline 일괄 재수립은
  운영자 확인 후 수동 트리거.
- 알림: 문서를 연결한 관리자(`linkedBy`)와 Google을 연결한 관리자(`connectedBy`)에게 DM.
  **공용 헬퍼는 없으므로 등록 승인 패턴을 복제**: `registration/request-access-action.ts`의
  관리자별 `chat.postMessage` + `{channel, ts}` 북키핑(여기서는 `reviewCards`에 저장),
  결정의 **first-click-wins 원자 클레임**(등록 기능의 `removeSessionData` changes>0 패턴 —
  여기서는 gdocs-sync.json CAS), 결정 후 `updateAllManagerMessages`식으로 나머지 카드를
  "Handled by @A"로 갱신. (여유가 되면 이 3종 세트를 `services/slack/`의 공용 헬퍼로 추출해
  registration/document-update와 공유 — 세 번째 복제이므로 추출 가치 있음.)
- 카드 내용: 문서명 + Doc 링크 + (있으면) 편집자 + 버튼 `[Review changes]`
  `[Restore replica]`. **`[Restore replica]`도 파괴적이므로 version 펜스**: 카드의
  `reviewedVersion`과 현재 version이 다르면 복원하지 않고 카드 갱신("The doc changed again
  since this card").
- drifted 상태에서 GitHub 쪽도 바뀌면 push는 보류되지만 커밋은 정상 진행 — 이후 3-way
  merge의 `ours`가 최신 GitHub 내용이므로 자연 수렴. 카드에 "GitHub side has also changed
  since"를 표시.
- 폴링 비용: `files.get` 5유닛/회 — 문서 수백 개여도 무시 가능(공식 쿼터 대비).

## P4 — 승인 환류 (2~3일)

**델타 추출** `services/google/gdocs-delta.ts` — 리뷰 화면 로드 시마다 재계산(저장하지 않음.
baseline·export·GitHub 모두 재조회 가능하므로 재기동에도 안전):

1. base=baseline, theirs=현재 export, ours=현재 GitHub markdown — 셋 다 배너 규칙 적용.
   **추출 시점에 `oursBlobSha`(GitHub 블롭 SHA)와 `reviewedVersion`(Doc version)을 기록.**
2. **export 문법 역정규화(측정 기반)**: 변환 노이즈는 unchanged 구간에서 상쇄되지만,
   **사람이 새로 쓴 줄은 Docs export 문법을 달고 들어온다.** 추가/변경된 헝크에 한해
   역이스케이프(`1\.`→`1.`, `\[`→`[`, `\=`→`=`)와 줄 끝 하드브레이크 공백 제거를 적용한 뒤
   ours에 병합한다. 적용 범위를 헝크로 한정하는 것이 중요하다 — 문서 전체에 돌리면
   원본에 의도적으로 있던 이스케이프까지 망가진다.
3. 이미지 정규화: export의 `[imageN]: <data:...>` 참조에서, base64 내용 해시가 baseline과
   동일한 이미지는 참조 토큰으로 치환(노이즈 상쇄). 측정상 base64 인코딩이 결정적이므로
   해시 비교로 충분하다. **새로운** data URL은 저장소 자산 후보로
   추출하되 반입 검증을 통과해야 한다: **매직 바이트 기준 래스터 allowlist(png/jpeg/gif/webp,
   SVG는 무조건 거부)** + 디코드 후 길이에 `MAX_ASSET_BYTES` 적용(버퍼링 전) + 델타당 자산
   수 상한. 기존 자산 라우트의 검증은 HTTP 경로에 붙어 있으므로 **여기서 동일 검증을 직접
   재적용**(우회 금지). 새 자산은 리뷰 카드/화면에 명시적으로 나열해 관리자가 인지하고 승인.
4. `node-diff3`(신규 소형 의존성; 대안: 로컬 gitrepo 미러에서 `git merge-file`)로 3-way merge.
5. **코드 블록 가드**: 델타 헝크가 ours의 펜스 코드 블록 범위와 교차하면 자동 병합하지 않고
   충돌로 승격. 측정 확인: Docs export는 펜스를 잃고 각 줄을 별도 문단으로 만들므로
   코드 블록 안의 편집은 구조적으로 자동 병합이 불가능하다.
6. 산출: `{ merged, conflicts[], newAssets[] }`.

**승인 UX** — 관리자 DM 카드에서:

- `[Review changes]` → 웹 뷰어의 리뷰 화면으로 딥링크
  (`/docs/:ws/:path?gdocsReview=1` — 기존 Slack→뷰어 딥링크 패턴과 동일): before/after diff
  표시(**`web/src/utils/diff.ts`의 `lineDiff` 재사용** — HistoryPanel의 diff 마크업은
  비공개 컴포넌트라 마크업만 모방, CSS `.history-diff/.diff-line/.diff-add/.diff-del`은 기존
  것 사용), 충돌 있으면 병합 결과를 에디터에 프리필해 수동 해결.
  `[Approve & commit]` / `[Reject & restore replica]`.
- **승인 펜스**: Approve 시 서버는 ① CAS(state=pending-review, 매핑 존재, auth 유효) →
  ② 현재 GitHub 블롭 SHA vs `oursBlobSha` — 다르면 최신 ours로 3-way 재실행 후 리뷰 화면으로
  반송(그 사이 낀 동료 커밋을 지우는 병합 커밋 방지; `getTargetBlobShas`가 이미 있어 저렴) →
  ③ `commitFilesWithContext`(문서 + 새 자산 + provenance 사이드카) → ④ force 재push
  (baseline·version 갱신) → state=synced.
- **거절 펜스**: Reject 시 ① CAS → ② 현재 Doc version vs `reviewedVersion` — 다르면(검토 중
  또 편집됨) 복원하지 않고 델타 재추출 + 카드 갱신 → ③ 같으면 force 재push(복원) →
  state=synced. 3분 폴링 간격 사이의 편집이 아무도 못 본 채 소실되는 것 방지.
- provenance: `ProvenanceType`에 `'gdocs-edit'` 추가. 타입 유니언은 **백엔드
  `services/document/provenance/types.ts`와 웹 `web/src/types.ts`에 중복 정의**되어 있고,
  `HistoryPanel.tsx`의 `TYPE_LABEL: Record<ProvenanceType, string>`이 컴파일 타임 exhaustive
  이므로 **세 곳을 함께 갱신** + `styles.css`에 `.history-badge.type-gdocs-edit` 추가.
  `ProvenanceRecord.source`는 현재 `{channelId?, threadTs?}`라 fileId를 받을 수 없음 —
  양쪽 타입에 `fileId?`/`editor?`를 확장. 레코드 생성은 `save-document.ts`의 'web-edit'
  플로우(커밋 → 미러 스테이징 → markGithubSyncSuccess → 벡터 갱신 → warmup)를 그대로 따름.
- Slack 카드에서 간단 승인(충돌·신규 자산 없음 + 소규모 델타일 때 diff 미리보기 + 원클릭
  approve)은 선택 확장 — v1은 웹 리뷰 화면만.

---

## 리스크와 전제

| 항목 | 상태 |
|---|---|
| 내용 교체 시 fileId/URL 유지 | **확인됨 (P0-A)** |
| Export 멱등성 | **확인됨 (P0-A)** — byte 단위 동일, base64 포함. 정규화 레이어 불필요 |
| version 펜스 | **확인됨 (P0-A)** — `files.update` 응답 version이 직후 `files.get`과 일치 |
| Picker per-file grant | 기존 문서 선택 UX의 전제. **미검증** — `picker-spike.ts`. 실패 시 "새 Doc 생성 + 폴더 선택"으로 격하 |
| Google export 직렬화 변경 | 통제 불가 외부 리스크. P3의 대량 드리프트 차단기로 완화 |
| baseline 유실 | data/는 비버전 관리(과거 디스크 사고 이력 있음). baseline-lost 상태 + 자동 재push 금지로 데이터 손실 방지 |
| `DOCS_BASE_URL` 공인 HTTPS | 이미지 임베드의 배포 전제. 비공개 호스트면 이미지는 드롭(렌더러의 기존 정책) |
| Export 10MB 제한 | 공식 하드 리밋. 일반 문서에는 여유. 초과 시 push는 되고 감지가 불가 — 매핑 시 크기 검사 |
| 공유 드라이브 | 선택 사항. `supportsAllDrives` 플래그는 스파이크에 이미 반영 |
| `ts-node` 불능(선재 이슈) | dev 스크립트 영향. 빌드(`tsc`)·테스트(`jest`)는 정상 — 구현에는 지장 없음 |

## 테스트 계획

- **단위**: 델타 추출(변환 노이즈 상쇄 픽스처 — 같은 내용의 baseline/export 쌍, 사람 편집
  주입, 코드 블록 충돌 승격, 이미지 data-URL 치환·검증 거부 케이스), 배너 규칙(과거 문구,
  배너-only 델타), 상태 기계 전이 + CAS(이중 승인, unlink-중-승인), publish 펜스(v0≠v1),
  매핑 세터(중복 fileId 거부).
- **통합**: drive-client를 목으로 대체한 publisher/detector/approve 플로우(jest 기존 패턴) —
  특히 "거절이 no-op이 되는" 회귀(force 모드)와 폴러-publisher 동시 진입(락) 시나리오.
- **수동**: P0 스파이크 체크리스트 + 실 워크스페이스 1개로 P1~P4 리허설.
