# Registration Approval Flow & Awareness Dashboard — Implementation Plan

CHI '26 필드 스터디 결과(privacy-awareness tension, §6.2.4/§6.4.1/§7.1)를 제품 기능으로 옮기는 2부 계획.
이 문서는 구현 세션(Claude Opus)이 단독으로 읽고 실행할 수 있도록 작성되었다. 구현 전 `CLAUDE.md`를 먼저 읽을 것.

**빌드 순서: Part A → Part B(P0 → P1 → P2 → P3).** Part A는 자체 완결적이며 Part B의 opt-in 전제가 된다.

---

## 확정된 설계 결정 (재논의 불필요)

| 결정 | 내용 |
|---|---|
| Opt-in 시점 | CHOIR 유저 등록 = 대시보드 익명 통계 수집 동의. 요청 버튼 화면에 고지 문구 포함 |
| 대시보드 접근 | 등록된 CHOIR 유저 전원(학생 포함) 열람 가능. 비등록자 차단. 게이트는 `isCHOIRUser` |
| k-anonymity | 토픽 클러스터는 **서로 다른 user_hash ≥ 2** 일 때만 개별 노출, 미달분은 "Other"로 합산 |
| 멘션 응답 | 미등록 유저의 공개 채널 멘션에는 `chat.postEphemeral`로 본인에게만 안내 |
| 보류 질문 | 등록 요청 시 원 질문을 세션에 보류 → 승인 시 자동 답변. 승인 전에는 LLM/로그로 전송 금지, 거절·만료 시 폐기 |
| 시간 해상도 | 대시보드 API/UI는 ISO 주 단위만 노출. 더 세밀한 타임스탬프는 절대 응답에 포함하지 않음 |
| UI 언어 | Slack/웹 사용자 노출 문구는 영어 (기존 제품 언어) |

### Non-goals — 절대 만들지 말 것 (프라이버시 레드라인)

- 사용자별 질문 수·목록·타임라인 등 **개인 단위 뷰 일체**
- 질문 **원문** 저장·표시 (LLM 패러프레이즈만 저장)
- ISO 주보다 세밀한 시간 정보의 API/UI 노출
- distinct user_hash < 2 인 토픽의 개별 노출

---

# Part A — 등록 요청 → 매니저 원클릭 승인

## A.0 현재 상태

- 미등록 유저가 DM([listeners/event-handlers/dm-handler.ts](../listeners/event-handlers/dm-handler.ts) ~L95) 또는 멘션([listeners/event-handlers/mention-handler.ts](../listeners/event-handlers/mention-handler.ts) ~L77)으로 질문하면 `getNonUserResponseMessage`([services/slack/user-management.ts](../services/slack/user-management.ts) L401)가 연구 시절 장문 안내(개발자 이메일 하드코딩)를 보낸다. 멘션 케이스는 채널에 **공개로** 게시됨.
- 등록은 매니저가 App Home → Manage CHOIR Users 모달(multi_users_select)로만 가능.
- 미러링할 패턴: [send-update-suggestion-to-manager-action.ts](../listeners/features/document-update/extract-knowledge/send-update-suggestion-to-manager-action.ts) — 세션 저장 → 매니저 전원 DM + 버튼 → `managerMessageInfo`로 모든 매니저 메시지 상태 동기화.
- 재사용 가능 API: `workspaceStore.addCHOIRUser(workspaceId, userId)` (단건, 중복 시 false 반환 — [workspace-store.ts](../services/workspace/workspace-store.ts) L681), SQLite 세션 스토어([services/common/session-store.ts](../services/common/session-store.ts), TTL 지원, 재시작 내구성 있음).

## A.1 목표 플로우

```
미등록 유저 질문 (DM 또는 멘션)
  → CHOIR: 짧은 안내 + [Request Access] 버튼 (멘션이면 ephemeral)
      · 원 질문을 세션에 보류 (LLM/로그 미전송)
  → 버튼 클릭 → 세션 pending 전환 + 매니저 전원 DM ([Approve] [Decline])
  → Approve: addCHOIRUser + 익명화 매핑 등록 → 매니저 DM 전부 "✅ approved by X"로 갱신
      → 유저 DM: 환영 메시지 + 보류 질문 자동 답변
  → Decline: 세션 declined 전환 → 매니저 DM 갱신 → 유저에게 정중한 안내 DM
```

## A.2 세션/상태 관리

`services/common/session-store.ts`의 `SessionType`에 추가:

```ts
REGISTRATION_REQUEST = 'registration_request',
```

새 서비스 `services/slack/registration-requests.ts`:

- 세션 ID는 결정적 키 `${workspaceId}:${userId}` — 중복 요청 방지가 저장 구조에서 공짜로 해결됨.
- TTL 30일.
- 데이터 형태:

```ts
interface RegistrationRequest {
  workspaceId: string;
  userId: string;
  userName: string;
  status: 'pending' | 'declined';
  heldQuestion?: string;        // 원 질문. 승인 전 LLM/로그 전송 금지
  originChannelId: string;
  originChannelType: 'dm' | 'public' | 'private';
  originThreadTs?: string;
  requestedAt: string;
  managerMessageInfo: Record<string, { channel: string; ts: string }>; // 매니저별 DM 메시지 좌표
}
```

- 함수: `createRequest`, `getRequest(workspaceId, userId)`, `markDeclined`, `clearRequest`.
- **주의**: App Home 모달 경로(`setCHOIRUsers`)로 수동 추가된 유저의 pending/declined 세션은 정리할 것 — [choir-users-handlers.ts](../listeners/features/app-home/management/choir-users-handlers.ts)의 제출 핸들러에서 추가된 유저마다 `clearRequest` 호출.

## A.3 미등록 유저 응답 재작성

`user-management.ts`의 `getNonUserResponseMessage`를 `buildNonUserResponse(state, managers, consentFormUrl?)` 로 교체. 하드코딩된 연구자 이메일 제거. `{ text, blocks }` 반환, 상태별 3종:

**fresh** (요청 이력 없음):

> Hi! 👋 I'm CHOIR, your team's documentation assistant. You're not registered as a CHOIR user yet — a workspace manager can approve you with one click.
>
> `[🙋 Request Access]` (action_id: `request_choir_access`)
>
> _context_: If approved, I'll answer the question you just asked right away — until then it stays private and isn't processed or stored in logs. Registering also includes your future questions in anonymous team insights (topic-level only, no names; you can opt out anytime in my App Home).

**pending**: 버튼 없이

> ⏳ Your access request is waiting for manager approval. I'll message you as soon as you're in!

**declined**: 버튼 없이

> Your earlier access request wasn't approved. Please reach out to a workspace manager directly if you think this is a mistake.

블록 ID는 dm-handler가 이미 쓰는 `createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION)` 재사용.

## A.4 핸들러 변경

**dm-handler.ts / mention-handler.ts** (두 곳 동일 로직):

1. `getRequest`로 상태 조회 → 상태별 `buildNonUserResponse` 블록 전송.
2. fresh 상태면 이번 질문 텍스트·채널 정보를 담아 세션을 **미리 생성하지 말고**, 버튼 `value`에 실을 수 없으므로(질문이 길 수 있음) **이 시점에 status 없는 임시 세션을 만들어 heldQuestion을 저장**하고 버튼 value에는 세션 키만 넣는다. 버튼 클릭 시 pending으로 승격. (버튼을 안 누르면 TTL로 자연 소멸. status 필드에 `'offered'` 를 추가해 3-상태로 관리: `offered → pending → declined/삭제`.)
3. **멘션 케이스는 `chat.postEphemeral`로 변경** — `channel: event.channel, user: userId`, 스레드면 `thread_ts` 전달. DM 케이스는 기존 `chat.postMessage` 유지.

## A.5 새 feature 폴더 `listeners/features/registration/`

기존 컨벤션(feature 폴더 + `index.ts` 등록, [listeners/index.ts](../listeners/index.ts)에 연결)을 따른다.

### request-access-action.ts — `request_choir_access`

1. `ack()` 즉시.
2. 세션 조회(`offered`) → `pending` 전환. 이미 pending이면 response_url로 "already requested" 안내 후 종료.
3. 매니저 목록 조회(`getManagers`). 0명이면 requester에게 "No managers are configured in this workspace — please contact your Slack admin." 안내 후 종료.
4. 매니저 전원에게 DM (send-update-suggestion-to-manager-action.ts 패턴 그대로):

> 🙋 *{userName}* requested access to CHOIR.
>
> _context_: Asked from {#channel-name | a direct message}. {consentFormUrl 설정 시: "Reminder: check that they've completed the <url|consent form>."}
>
> `[✅ Approve]` `[Decline]` (action_id: `approve_choir_registration` / `decline_choir_registration`, value = 세션 키)

5. 각 DM의 `{channel, ts}`를 `managerMessageInfo`에 저장.
6. requester의 원 메시지를 response_url로 교체: "✅ Request sent to *{manager names}*. If approved, I'll answer your question right away."
7. `logButtonClick`(action `request_choir_access`)으로 계측 (기존 interaction-tracker 사용, `loggingEnabled` 존중).

### approve-registration-action.ts — `approve_choir_registration`

**레이스 안전 순서** (매니저 2명이 동시에 눌러도 안전해야 함):

1. `ack()` → 세션 조회. 세션이 없거나 `isCHOIRUser`가 이미 true면: 본인 DM 메시지만 "✅ *{userName}* — already approved."로 갱신하고 종료.
2. `approveCHOIRUser(workspaceId, userId, client)` 호출 — `user-management.ts`에 신설:
   - `workspaceStore.addCHOIRUser` (중복 시 false 반환이 멱등성 백스톱)
   - **익명화 매핑 등록** — `setCHOIRUsers`의 L321–332와 동일하게 `getUserName` → `getAnonymizationMapping(userId, userName, undefined, workspaceId)`. 누락 시 해당 유저 이름이 마스킹 없이 LLM으로 나가므로 필수.
3. `managerMessageInfo`의 모든 매니저 DM을 `chat.update`로 "✅ *{userName}* — approved by *{approverName}*." 갱신 (버튼 제거).
4. requester에게 환영 DM:

> 🎉 You're in! You can now ask me anything about the team's documentation, share Q&As, and suggest document updates.
>
> Here's the answer to your earlier question:

5. `heldQuestion`이 있으면 **기존 질문 처리 경로 그대로** 실행해 requester DM에 답변 게시 — dm-handler가 쓰는 공유 메시지 핸들러/`QuestionProcessor` 경로를 재사용해 레퍼런스·공유 배너 등 일반 답변과 동일한 형태가 되게 한다. 원 출처가 공개 채널이었다면 답변 말미에 컨텍스트 한 줄: "You originally asked in #{channel} — feel free to share this there."
6. `clearRequest` (세션 삭제), `logButtonClick`(action `approve_choir_registration`).

### decline-registration-action.ts — `decline_choir_registration`

1. 세션 `declined` 전환(heldQuestion은 이 시점에 **삭제**), 매니저 DM 전부 "🚫 *{userName}* — declined by *{approverName}*." 갱신.
2. requester DM: "Your CHOIR access request wasn't approved this time. If you have questions, please reach out to a workspace manager directly."
3. `logButtonClick` 계측.

## A.6 테스트 (`__tests__/registration-requests.test.ts` 등, 기존 플랫 jest 컨벤션)

- 상태 머신: offered 생성 → pending 승격 → 중복 요청 무시 → declined 전환 시 heldQuestion 제거 확인.
- 승인 멱등성: 동시/중복 approve 시 `addCHOIRUser` 1회만 유효, 두 번째는 no-op 경로.
- `buildNonUserResponse` 3-상태 블록 스냅샷.
- App Home 수동 추가 시 세션 정리 확인.

## A.7 검증

`pnpm build && pnpm lint && pnpm test` 통과 후, `pnpm dev:socket`으로 수동 시나리오:

1. 미등록 계정으로 DM 질문 → 버튼 응답 확인 → 클릭 → 매니저 DM 수신
2. 승인 → 유저 환영 DM + 보류 질문 답변 도착, 매니저 측 메시지 갱신
3. 미등록 계정으로 공개 채널 멘션 → **본인에게만 보이는지**(ephemeral) 확인
4. 거절 플로우, 매니저 0명 워크스페이스, 중복 요청

---

# Part B — Awareness Dashboard (privacy-preserving)

## B.0 (P0) 수집 파이프라인

### 설정 필드 (WorkspaceConfig, [workspace-store.ts](../services/workspace/workspace-store.ts))

```ts
dashboardEnabled?: boolean;    // 기본 true. 매니저가 App Home에서 비활성화 가능
dashboardOptOut?: string[];    // 개인 opt-out한 userId 목록
dashboardSalt?: string;        // user_hash용 워크스페이스별 랜덤 솔트(hex 32자). 최초 이벤트 기록 시 생성
```

### DB 마이그레이션 ([services/db/connection.ts](../services/db/connection.ts)의 기존 `schema_migrations` 패턴)

```sql
CREATE TABLE IF NOT EXISTS qa_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,      -- 내부 보존·디버그용. API로는 절대 노출하지 않음
  iso_week TEXT NOT NULL,           -- '2026-W29'. API 노출 최소 단위
  channel_type TEXT NOT NULL,       -- dm | public | private
  can_answer INTEGER NOT NULL,
  search_results INTEGER NOT NULL,
  user_hash TEXT NOT NULL,          -- HMAC-SHA256(dashboardSalt, userId). k-anonymity 카운트 전용
  paraphrase TEXT,                  -- LLM 탈맥락화 질문. 원문은 저장하지 않는다
  embedding BLOB,                   -- paraphrase의 임베딩 (Float32Array 직렬화)
  topic_id INTEGER                  -- qa_topics FK, 클러스터링 잡이 채움
);
CREATE INDEX IF NOT EXISTS idx_qa_events_ws_week ON qa_events(workspace_id, iso_week);

CREATE TABLE IF NOT EXISTS qa_event_chunks (   -- 검색에 쓰인 청크 (문서 히트맵 원천)
  event_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  section_id TEXT,
  heading_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_qa_event_chunks_event ON qa_event_chunks(event_id);

CREATE TABLE IF NOT EXISTS qa_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,              -- LLM 생성 짧은 라벨
  representative TEXT NOT NULL,     -- 대표 패러프레이즈
  updated_at INTEGER NOT NULL
);
```

### 레코더 `services/dashboard/qa-event-recorder.ts`

`recordQaEvent({ workspaceId, userId, question, canAnswer, relevantDocs, channelType })`:

1. 게이트: `dashboardEnabled !== false` && `!dashboardOptOut.includes(userId)` && `isCHOIRUser`.
2. 질문 텍스트에 기존 [anonymization-service](../services/anonymization/anonymization-service.ts) 적용 **후** LLM 패러프레이즈 1회 호출(기존 completions 헬퍼 사용). 프롬프트:

```
Rewrite the user's question as a short, generic FAQ-style question in English.
Remove all personal context: names, projects, deadlines, personal circumstances, and specifics.
Keep only the underlying information need. Output only the rewritten question.

Example: "I'm the second author on a CHI paper, can I still get travel funding?"
      →  "Is conference travel funding available for second authors?"
```

3. 패러프레이즈 임베딩 생성 — OpenAI embeddings, 모델은 [llm-config.ts](../services/llm/llm-config.ts) `embeddingsModel`(text-embedding-3-small), 클라이언트는 openai-client-factory 재사용.
4. `qa_events` + `relevantDocs`의 `DocumentMetadata`(`fileName`/`sectionId`/`headingPath` — [file-registry/types.ts](../services/file-registry/types.ts))로 `qa_event_chunks` insert.
5. **비동기 분리 실행**: 답변 지연에 영향을 주지 않도록 fire-and-forget(`void (async …)().catch(log)`). 실패해도 답변 플로우는 무손상.

### 훅 지점

[services/qa/question-processor.ts](../services/qa/question-processor.ts)의 `answerQuestion` 완료 직후. `channelType`은 현재 processQuestion 시그니처에 없으므로 호출부(dm/mention/공유 메시지 핸들러)에서 파라미터로 전달하도록 스레딩.

### 백필 스크립트 `scripts/backfill-qa-events.ts` (dev 전용)

`data/logs/user-interactions-*.jsonl`에서 `action === 'process_question'` 라인을 읽어 동일 레코더 경로로 주입. `--workspace <id>` 필터. 필드 스터디 데이터(107문항)로 클러스터링 임계값 튜닝에 사용. 소스 로그는 절대 수정하지 않는다.

## B.1 (P1) 클러스터링 + API + 웹 대시보드

### 클러스터링 잡 `services/dashboard/topic-clusterer.ts`

- 24시간 주기 `setInterval` — [app.ts](../app.ts) L823 세션 스윕과 같은 패턴으로 등록. 기동 시 1회 즉시 실행.
- 알고리즘: 그리디 센트로이드 클러스터링(신규 이벤트를 코사인 유사도 최근접 토픽에 할당, `TOPIC_SIM_THRESHOLD`(기본 0.80, env로 조정) 미만이면 새 토픽 생성). 연구실 규모(수백 건)에는 충분 — 외부 ML 의존성 추가 금지.
- 새 멤버가 붙은 토픽은 LLM으로 `label`/`representative` 재생성(멤버 패러프레이즈 최대 20개 입력).

### API — 새 모듈 `services/dashboard/dashboard-routes.ts` (app.ts 비대화 방지, docs 라우트처럼 마운트)

인증: 기존 `/api/docs/*`의 세션 쿠키 패턴 재사용, **게이트는 `isCHOIRUser`** ([app.ts](../app.ts) L523의 `isManager` 게이트와 동형). 모든 응답은 ISO 주 단위.

| 엔드포인트 | 응답 |
|---|---|
| `GET /api/dashboard/:workspaceId/summary?weeks=12` | 주별 질문 수, 답변률(can_answer 비율), 활성 토픽 수 |
| `GET /api/dashboard/:workspaceId/topics?weeks=12` | 토픽별 {label, representative, count, weeklyCounts, answeredRatio}. **k 필터 적용** |
| `GET /api/dashboard/:workspaceId/gaps?weeks=12` | can_answer=false 비중 높은 토픽 + 그때 검색됐던 문서/섹션 목록("retrieved but insufficient") |
| `GET /api/dashboard/:workspaceId/doc-usage?weeks=12` | 파일/섹션별 검색 횟수, 마지막 검색 주. cold 문서(N주 무검색) 플래그 |
| `GET /api/dashboard/:workspaceId/doc-usage?weeks=12&file=<path>` | 단일 파일 상세(하이라이트용): 섹션별 `{ sectionId, headingPath, startLine, endLine, retrievedCount, answeredCount }` + `unmatchedCount`. 라인 범위는 **서버가 현재 파일 내용에 markdown-section-splitter를 돌려 계산** — 과거에 기록된 청크가 이후 문서 개편으로 현재 섹션과 매칭되지 않으면 `unmatchedCount`로 합산해 정직하게 표기 |

**k-anonymity 구현**: 서버 상수 `K_MIN_DISTINCT_USERS = 2`. 토픽·주 윈도우별 `COUNT(DISTINCT user_hash) >= 2` 미달 토픽은 개별 노출 금지, `{ label: 'Other', count }` 단일 버킷으로 합산. 이 로직은 반드시 서버에서 수행(클라이언트 필터 금지).

### 웹 UI ([web/](../web/) SPA 확장)

- `web/src/App.tsx`에 해시 라우트 `#/dashboard` 추가(기존 SPA 구조 유지), 상단에 "Docs | Insights" 탭.
- 컴포넌트: `DashboardView.tsx`(레이아웃+데이터 페칭), `GapBoard.tsx`(핵심 — 미답변 토픽 카드: 대표 질문, 건수, 관련 문서), `TopicTrends.tsx`(주별 토픽 추이 스택 차트), `StatsHeader.tsx`(질문 수·답변률 타일).
- 차트 라이브러리: `recharts`를 `web/package.json`에 추가. 라이트/다크 테마 모두 대응, 절제된 단일 팔레트.
- 게이트: `/api/docs/session`의 `isChoirUser`가 false면 대시보드 탭 숨김 + 라우트 접근 시 안내.
- **양방향 내비게이션**: 대시보드는 doc viewer와 같은 SPA의 탭이므로 서로 딥링크로 연결한다 — GapBoard 카드의 관련 문서 클릭 → `#/docs/<file>?usage=1`(usage 하이라이트 자동 켜짐, B.2)로 이동, DocHeader에는 Insights 탭 진입점.
- 화면 하단 고정 고지: "Aggregated by topic and week. No individual activity is shown. Topics asked by fewer than 2 people are grouped as 'Other'."

## B.2 (P2) 문서 내 Q&A usage 하이라이트 + 주간 다이제스트

### Q&A usage 하이라이트 토글 (doc viewer 내장)

별도 차트 페이지가 아니라 **문서를 읽는 자리에서** 어떤 섹션이 Q&A에 쓰이는지 보여준다.

- [DocHeader.tsx](../web/src/components/DocHeader.tsx)에 토글 버튼 "Q&A usage" 추가. **view 모드 전용**(편집 중에는 비활성, 편집 시작 시 자동 off).
- 켜면 `doc-usage?file=<path>` 상세 API 호출 → 섹션별 라인 범위 + 카운트 수신.
- **렌더링 매핑은 기존 provenance 마커 인프라 재사용**: [DocViewer.tsx](../web/src/components/DocViewer.tsx)의 `normalizeForLineMatch` 기반 블록↔소스라인 매칭이 이미 line→record 마커를 배치하고 있으므로, 같은 메커니즘으로 line 범위→섹션 하이라이트를 배치한다(새 매칭 휴리스틱 작성 금지). 기존 마커와 동일하게 reflow 시 재계산.
- 시각화:
  - 섹션 블록 범위에 배경 틴트. 강도는 파일 내 카운트 분포로 3~4버킷(로그 스케일), 라이트/다크 테마 모두 텍스트 대비를 해치지 않는 저알파 CSS 변수로.
  - 헤딩 우측에 카운트 칩: hover 시 "Retrieved in {n} questions (last 12 weeks) · {m} answered".
  - `answeredCount/retrievedCount`가 낮은 섹션(자주 검색되지만 답을 못 만드는 = 부실 섹션)은 칩에 ⚠️ 표시 — gap 보드와 상보적인 신호.
  - `unmatchedCount > 0`이면 문서 상단에 각주: "{n} retrievals refer to earlier versions of sections that have since changed."
- 딥링크 `?usage=1` 지원(대시보드 GapBoard에서 진입 시 자동 켜짐). 토글 상태는 localStorage에 파일 무관 전역으로 기억.
- 프라이버시: 섹션 카운트는 전원 집계값이라 k 이슈 없음. 접근은 어차피 세션 + `isCHOIRUser` 게이트.

### 파일 단위 요약

- [FilesSidebar.tsx](../web/src/components/FilesSidebar.tsx)에 파일 단위 배지: 🔥 hot(상위 검색) / 🧊 cold(6주+ 무검색, 정리 후보). 데이터는 doc-usage 목록 API 재사용.

### 주간 다이제스트 `services/dashboard/weekly-digest.ts`

- 일 1회 tick(setInterval). 워크스페이스별로 `app_state`에 `digest:last:{workspaceId}` = 마지막 발송 ISO 주 저장, 현재 주와 다르면 발송.
- `dashboardEnabled === false`면 스킵. 수신자: `getManagers`.
- 내용(블록): 지난주 질문 수·답변률, 신규/급증 gap 토픽 상위 3개(라벨+건수), 대시보드 링크(`…/docs#/dashboard?src=digest` — src 파라미터는 계측용).
- 발송 시 `interactionTracker`에 `digest_sent` 기록.

## B.3 (P3) Opt-out + 문서화 루프 + 연구 계측

### 개인 opt-out (App Home)

- 멤버 섹션에 토글: "Include my questions in anonymous team insights" (기본 on — 등록 시 고지된 opt-in).
- Opt-out 시: `dashboardOptOut`에 추가 **그리고 소급 삭제** — 해당 유저 `user_hash` 계산 후 `DELETE FROM qa_events WHERE workspace_id=? AND user_hash=?` + 고아 `qa_event_chunks` 정리. Opt-in 복귀 시 목록에서 제거(과거 데이터는 복구되지 않음을 UI에 명시).

### Gap → 문서화 루프

- GapBoard 카드에 "Draft an update" 버튼 → `POST /api/dashboard/:workspaceId/gaps/:topicId/draft` (**이 엔드포인트만 `isManager` 게이트**).
- 동작: 해당 토픽 `representative`를 지식 텍스트로 삼아 **기존 document-update 제안 파이프라인**(SessionType.DOCUMENT_UPDATE, 매니저 DM 시작점)에 주입 — 매니저 본인 DM에 기존 "Start Update Process" 메시지가 도착해 이후는 기존 플로우 그대로.

### 연구 계측 (모두 기존 interaction-tracker 경유, `loggingEnabled` 존중)

| 이벤트 | 소스 | 연구 질문 |
|---|---|---|
| `request_choir_access` / `approve…` / `decline…` (+타임스탬프 간격) | Part A 액션 | 온보딩 마찰: 요청→승인 지연, 승인율 |
| `dashboard_view` (역할: manager/member) | dashboard-routes 미들웨어, 세션당 30분 스로틀 | awareness 소비 주체와 빈도 |
| `digest_sent`, 대시보드 진입 시 `?src=digest` | weekly-digest / SPA | push vs pull 효과 |
| `gap_draft_clicked` → 기존 `apply_document_update`와 연결 | B.3 엔드포인트 | **핵심 종속변수**: gap 가시성 → 문서 갱신 전환 |
| `dashboard_opt_out` / `opt_in` | App Home 토글 | 프라이버시 장치 신뢰도 |

## B 테스트

- `__tests__/iso-week.test.ts`: 주 계산 유틸(연말 경계 포함).
- `__tests__/dashboard-k-anonymity.test.ts`: distinct user_hash 1인 토픽이 응답에서 "Other"로 합산되는지 — **가장 중요한 테스트**.
- `__tests__/topic-clusterer.test.ts`: 합성 임베딩으로 임계값 상/하 케이스, 증분 할당.
- `__tests__/qa-event-recorder.test.ts`: 게이트(비활성/opt-out/비유저) 시 미기록, 원문 미저장(레코드에 question 원문이 없는지 명시적 assert).
- Opt-out 소급 삭제 동작.

## B 검증

- B0: 백필 실행 → sqlite3로 `qa_events` 표본 점검(패러프레이즈에 이름·프로젝트 부재 확인), 답변 레이턴시 무영향 확인.
- B1: 스터디 백필 데이터로 클러스터 품질 눈검사(107문항 → 대략 10~20 토픽 기대), k 필터 API 테스트, `pnpm dev:oauth`로 웹 로그인 → 대시보드 렌더 확인.
- B2: usage 토글 on/off·테마 전환·리사이즈(reflow 재계산)·편집 진입 시 자동 off 확인, 섹션 개편된 파일에서 `unmatchedCount` 각주 확인, 다이제스트 강제 발송(마지막 발송 주 수동 리셋) 확인.
- 각 단계 `pnpm verify` 통과.

---

## 구현 세션을 위한 메모

- Slack 페이로드 파싱은 `listeners/`, 도메인 로직은 `services/` (CLAUDE.md 컨벤션).
- `data/`, `dist/`, 실제 `.env`는 커밋 금지.
- Part A와 B0는 독립적으로 PR 분리 가능. B1은 B0 데이터 필요.
- 기존 문구·코드에 남은 연구 시절 잔재(개발자 이메일 등)는 Part A 범위에서 정리하되, `CHOIR_CONSENT_FORM_URL` 지원은 유지(설정된 워크스페이스에서만 표시).

---

## 현지화된 토픽 라벨 (Localized topic labels)

대시보드의 토픽 라벨은 **영어로 생성**된다. 질문은 익명화 후 영어로 패러프레이즈되고(`services/dashboard/paraphrase.ts`), 그 영어 문장이 임베딩·클러스터링의 키이므로 라벨도 영어가 기준이다. 한국어 사용자를 위해서는 이 영어 라벨을 **표시용으로 번역**해 함께 저장한다.

**저장.** `qa_topics.labels_json` (TEXT, nullable) — 비영어 로케일만 담는 JSON 객체다.

```json
{ "ko": { "label": "출장 지원금", "representative": "출장 지원금을 받을 수 있나요?" } }
```

영어는 기존 `label` / `representative` 컬럼에 그대로 남는다(클러스터링 키). 로케일별 컬럼 대신 JSON 한 칸이라 로케일이 추가돼도 마이그레이션이 없다. 컬럼 추가는 `services/db/connection.ts`의 `addColumnIfMissing()`이 `PRAGMA table_info`로 확인 후 `ALTER TABLE`을 실행하므로, 기존 배포 DB에서도 앱을 열기만 하면 자동으로 붙고 재실행해도 안전하다.

**생성 시점.** 클러스터링 배치(`topic-clusterer.ts`)가 영어 라벨을 (재)생성한 직후, 지원 로케일 중 `en`을 제외한 각 로케일마다 `createStructuredResponse` 한 번(`purpose: 'classification'`, `temperature: 0`, `skipAnonymization: true` — 입력이 이미 익명화된 텍스트라 역익명화로 실명이 복원되면 안 된다). 영어 라벨/대표질문이 **바뀌었을 때만** 다시 번역하고, 바뀌지 않았으면 저장된 `labels_json`을 그대로 재사용한다. 따라서 안정된 토픽은 매 실행마다 추가 LLM 호출이 없다.

**폴백.** 번역 호출이 실패하면 해당 로케일 항목을 비워 두고 영어가 그대로 노출된다. API(`dashboard-api.ts`)는 `?lang=` (없으면 `en`, `ko-KR` 같은 지역 태그는 `normalizeLocale`로 정규화)에 해당하는 번역이 있으면 기존 `label`/`representative` 필드에 번역을 담아 주고, 없으면 영어를 담는다. 응답 스키마는 그대로이고 `labelLocale: 'en' | 'ko'` 필드만 추가돼 UI가 실제 언어를 알 수 있다(`lang` 속성에 사용). SPA는 세 엔드포인트 요청에 `?lang=`을 붙이고 언어가 바뀌면 다시 가져온다.

**백필.** 번역 단계 이전에 만들어진 토픽(혹은 새로 추가된 로케일)은 다음 명령으로 채운다. 이미 해당 로케일이 있는 토픽은 건너뛰므로 여러 번 실행해도 안전하다.

```bash
pnpm backfill:dashboard:labels --workspace <workspaceId> [--locale ko] [--dry-run]
```
