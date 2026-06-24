# 지식 추출(Knowledge Extraction) 재설계 노트

> 상태: **설계 진행 중 (미구현)**. Slack 대화 → 문서 업데이트 흐름에서 "① 대화 context를 모으는 부분"과 "② 그 context로 지식을 추출하는 부분"을 개선하기 위한 결정 모음.
> 관련 코드: `services/slack/conversation-history.ts`, `services/llm/knowledge-extractor.ts`, `listeners/features/document-update/extract-knowledge/`.

---

## 1. 배경 — 지금 무엇이 문제인가

현재 흐름: 멘션/답글 → 대화 히스토리 수집 → 지식 추출(LLM) → 검색 → 문서 편집.

실측 시뮬레이션(gpt-5.4-mini)에서 드러난 주요 문제:

- **컷으로 인한 쓰레기 출력**: 추출 직전 "가장 최근 CHOIR 답변 이후"만 남기는 컷이, 정작 문서화할 *내용*(답변 이전의 설명)을 버린다. 그 결과 모델이 내용 없는 메타 문장만 생성.
  - 예) 입력엔 배포 절차 설명이 있었는데 → 출력: *"배포 절차가 설명되었고 저장 요청되었다"* (절차 내용 없음)
- **언어 불일치**: 한국어 대화인데 영어로 추출됨 (프롬프트에 출력 언어 지정 없음).
- **미합의 과대추출**: 결정 안 된 토론을 정책처럼 문서화.
- **상대적 시간 박제**: "다음 주 월요일" 같은 표현이 그대로 저장돼 나중에 의미 깨짐.
- **수집 윈도우의 거친 컷**: 세션 경계를 잡아놓고도 `마지막 5개`로 잘라 맥락 머리가 날아감. 채널 타입별로 위험도가 정반대(일반채널 10분 vs DM/Q&A 3일).

---

## 2. 새 파이프라인 한눈에

핵심 원칙: **넉넉히 모으되(recall) 추출 직전에 좁힌다(precision). 길이를 최대화하지 않는다.**

```
트리거(멘션/답글)
  │
  ├─ 후보 수집 (recall)
  │    스레드면:  부모 + 답글 전체  (명시적 관련 → 통째 포함)
  │             + 부모 이전 채널 버스트 (암묵적 → 시간갭/세션마커/cap으로 바운드)
  │    비스레드면: 트리거에서 뒤로 시간갭 버스트 (동일 cap)
  │    ※ 비-CHOIR 유저 메시지는 제외(동의 원칙), 봇은 내용 제외·마커로만 사용
  │
  ├─ 기본 선택 (precision)
  │    경량 LLM이 "관련 있는 메시지"에 default 체크
  │    + mention 위치(사람 답글 수)로 부모이전 버스트 default 강도 조절
  │
  ├─ 체크박스 UI
  │    사용자가 default에서 가감 (비-CHOIR 메시지는 disabled로 표시)
  │
  └─ 추출 (LLM)
       사용자가 확정한 메시지만 입력 → 짧고 on-topic → "lost in the middle" 회피
```

---

## 3. 확정된 결정 (예시 포함)

### D1. 동의(consent) 원칙 — 비-CHOIR 유저 제외 유지
CHOIR를 쓰지 않는 사람의 메시지는 추출에 사용하지 않는다. 본인이 허락하지 않았기 때문.
- 부작용: CHOIR 유저 A ↔ 비-CHOIR 유저 B 대화면 A의 발화만 남아 맥락이 "반쪽"일 수 있음 → **의도된 trade-off**. 체크박스에서 빠진 메시지는 *"비-멤버라 제외"* 로 보여 투명하게.

### D2. 트리거는 멘션만 (Slack 메시지 숏컷 없음)
구독 이벤트: `app_mention`, `message.im`, `message.mpim`. 우클릭 "이 메시지 문서화" 액션은 도입 안 함.
- 오래된 메시지는 **그 메시지에 답글로 @CHOIR** 하는 방식으로 처리.

### D3. 스레드 vs 채널 비대칭
| 구간 | 관련성 신호 | 처리 |
|---|---|---|
| 스레드(부모+답글) | 명시적(사람이 직접 묶음) | 갭 상관없이 **통째 포함** |
| 부모 이전 / 트리거 주변 채널글 | 암묵적(시간상 가까움) | **시간갭·세션마커·cap으로 바운드** |

### D4. 부모 이전 채널 맥락 포함 (답글 멘션 시)
`conversations.history({ channel, latest: 부모ts })`로 부모 이전 채널글을 가져와, 부모로 이어지는 "버스트"만 포함. 부모가 결론/요약이고 진짜 논의가 그 앞에 있던 경우를 살림.

### D5. mention 위치 규칙 (부모 이전 버스트의 default 강도)
mention **앞의 사람(human) 답글 수**로 판단 (봇/CHOIR 메시지는 카운트 제외).
- **이른 mention (사람 답글 ≤ 2)**: 스레드가 얇음 → substance는 부모+이전 → 부모이전 버스트 **default 체크**.
- **늦은 mention (사람 답글 > 2)**: substance는 스레드 → 부모이전 버스트는 **항상 fetch하되 default 해제**(사용자가 켤 수 있게).
- 예) `부모 → CHOIR 자동응답 → @CHOIR` = 사람 답글 0 → **이른**.

### D6. back-scan 안전 cap
시간갭/세션마커를 못 만나도 **15개 또는 90분 중 먼저 닿는 것**에서 강제 종료 (env로 조정). 활발한 채널에서 후보가 무한정 커지는 것 방지.

### D7. 체크박스 UI + 경량 LLM
경량 LLM은 "추출"이 아니라 **default 선택**을 담당. 사용자가 최종 확정한 메시지만 추출에 들어감. → 추측을 *확인 가능한 선택*으로 전환.

### D8. intent 분류에 부모 텍스트 한 줄 주입
답글 멘션일 때, 분류기 입력에 부모 메시지 텍스트를 한 줄 보태 오분류(예: 짧은 "@CHOIR" 답글)를 줄임. **추가 API 호출 없이** 이벤트의 부모 텍스트만 사용.

### D9. `conversationStartIndex` 컷 제거 (로직 버그 수정)
"가장 최근 CHOIR 답변 이후만 남기는" **slicing 로직을 전부 제거**한다(기존 컷 관련 로직 무시 가능). 선택된 메시지는 자르지 않고 모두 추출 입력으로.
- 단, CHOIR의 직전 답변을 **"현재 문서 상태(qaContext)" 블록으로 주입하는 것은 유지** — 정정 케이스(S1/S6)에 필요. 이건 "컷"이 아니라 맥락 주입이라 남긴다.
- 효과 (실측): 컷 유지 시 *보류*, 컷 제거 시 **제대로 된 문서**.
  > **# 배포 절차**
  > main에 머지되면 CI가 staging에 자동 배포된다. prod 배포는 수동으로 진행된다. QA 승인은 prod 배포 전에만 받으면 된다.

### D10. 추출 프롬프트 개선 (실측 검증됨)
- **출력 언어 = 대화 언어** (한국어 대화 → 한국어 출력).
  > **# 회의실 예약 방식 변경** / 회의실 예약은 이제 슬랙이 아니라 노션의 'Room Booking' DB에서 진행한다. …
- **합의된 사실만**, 미합의 토론은 `No organizational knowledge found`(보류).
- **쓰레기보다 보류**: 입력에 실제 내용이 없으면(예: "위에 설명한 거 저장해줘"인데 설명이 없음) 지어내지 말고 보류.
- **정정 처리**: CHOIR 직전 답변을 현재 상태로 보고, 값 변경/교체/증감/수정을 반영.
  > (휴가 15→20일) **# 휴가 일수 정책** / 직원은 연간 20일의 휴가를 받는다.
- **상대적 시간 → 절대 날짜**: 대화 날짜를 주입해 "다음 주 월요일"→`2026-06-29` 식으로 변환. 단 "매월 5일" 같은 *진짜 반복*은 그대로 둠.
- **출력 형식 = 단락만** (리스트/번호 사용 안 함). ← 최종 결정
- 사람 귀속 금지, URL 보존.

### D11. 검색 쿼리 = 추출된 제목 (full 구조화 X)
추출 결과 blob 전체를 검색 쿼리로 쓰던 것을 바꿔, **`# 제목`만 파싱해 쿼리로 사용**. 사용자 편집용 freeform 본문은 그대로 유지(구조화 출력은 도입 안 함 — 읽기/편집 편의 우선).

---

## 4. clarify 항목

### ✅ 확정됨

**C1. 시간갭 임계값 → 30분, env로 조정.**
버스트를 끊는 "침묵 갭" 기준 = 30분. env `EXTRACTION_TIME_GAP_MINUTES`(기본 30). cap(90분/15개)과는 별개 — cap은 최후 안전판, 갭은 토픽 경계.

**C3. 경량 선택기 → nano 모델 + 직접 작성한 프롬프트(부록 C).**
- 모델: nano(`CLASSIFICATION_MODEL = gpt-5.4-nano-2026-03-17`) 재사용, 구조화 출력(`createStructuredResponse`).
- 역할 분리: **LLM = 순수 토픽 관련성 판단**, **코드 = 위치 게이트 적용**.
  - 스레드 메시지: default-check = LLM 관련성(스레드 내 잡담은 LLM이 해제 가능).
  - 부모 이전 버스트: 이른 mention(≤2)일 때만 default-check 후보, 늦으면 default 해제(LLM 무관, 사용자가 수동으로 켤 수 있음).

**C4. 체크박스 — 긴 메시지는 `…`로 잘라서 표시.**
실제 전문은 사용자가 Slack에서 바로 확인 가능하므로 OK. 체크박스는 **메시지 선택을 돕는 보조 수단**일 뿐. 최대 표시 개수 = cap(15)과 정렬. 비-CHOIR 메시지는 disabled로 표시.

**C6. 시간 주입 출처 → 트리거 유저의 `users.info().user.tz`.**
- "대화 날짜" 출처 = 트리거 메시지 ts(절대 시각).
- 타임존 = **트리거 유저의 tz**. 추출 핸들러가 이미 extractorName 용으로 `users.info`를 호출하므로 **추가 API 호출 없이** `user.tz`를 읽음. (`team.info`는 tz를 주지 않음.)
- fallback: `DEFAULT_TIMEZONE` env(기본 `America/New_York` = 미 동부, EST/EDT, 서머타임 자동 반영).

**cap(추출 lookback) 확정.** `EXTRACTION_MAX_CANDIDATE_MESSAGES`(기본 15), `EXTRACTION_MAX_LOOKBACK_MINUTES`(기본 90).

**C5. 비-스레드 멘션 윈도우 통일.**
일반 채널 10분 하드컷 + API `oldest` 컷을 제거하고, 스레드/비-스레드 모두 **"트리거에서 뒤로 시간갭 버스트 + cap(15/90)"** 단일 규칙으로 통일.
- `classifyChannel`의 timeLimit(10분/3일)은 **추출 윈도우 경계로는 더 이상 사용 안 함**(채널 type/displayName은 맥락 표시용으로 유지).

**C2. 부모가 세션 마커인 경우 → 비움 유지 (흔한 경우 최적화, 확정).** (예시는 §4.1)

### 🔲 남은 항목

**C7. 세션 마커 견고성 (선택적 하드닝).**
마커가 `block_id`에만 있고, suffix가 붙은 `block_id`는 정규식이 타입 추출에 실패함. 신뢰성을 위해 Slack `metadata.messageType`도 함께 게시할지(선택).

### 4.1 예시 — "부모가 세션 마커인 경우"(C2)

세션 마커 = CHOIR가 올린 특정 메시지(예: `DOCUMENT_SUGGESTION` 제안, `ANONYMOUS_QUESTION` 등). 그 메시지에 답글로 트리거하면 **부모 자체가 마커**가 된다.

**흔한 경우(비움이 맞음):** CHOIR 제안을 정정.
```
채널 타임라인
  (A) 이서연: WiFi 비번 sunflower2023이야               ← 제안을 낳은 대화
  (B) [CHOIR · DOCUMENT_SUGGESTION] 제안: WiFi 비밀번호는 sunflower2023   ← 세션마커 = 부모
       └ (답글) 박지훈: @CHOIR tulip2026으로 바꿔서 저장해줘            ← 트리거
```
- 부모 이전 back-scan은 B(마커)에서 즉시 멈춤 → **부모 이전 = 비움**(A 제외).
- 그래도 OK: 부모 B는 스레드 부모라 **항상 포함** → 입력에 "sunflower2023"(B) + "tulip2026"(답글) → 정정 성립.

**드문 엣지(비움이 손해):** 진짜 사실이 *무관한* 마커 바로 앞에 있고, 답글이 그걸 가리킴.
```
  (A) 이서연: 신규 입사자는 첫날 IT에서 노트북 받아         ← 진짜 사실
  (B) [CHOIR · DOCUMENT_SUGGESTION] 제안: (다른 주제)        ← 무관한 마커 = 부모
       └ (답글) 박지훈: @CHOIR 위에 노트북 얘기 저장해줘       ← A를 가리킴
```
- back-scan이 B에서 멈춰 A 제외 → "위에 노트북 얘기"가 dangling → 보류로 끝남.
- 빈도 낮음 → **비움 유지로 확정**(흔한 경우 최적화). 이 엣지는 **알려진 한계로 수용** — 답글이 가리키는 사실이 마커 앞에 있으면 추출이 보류된다(쓰레기보다 보류, D9·D10 정합).

---

## 5. API rate limit 대응 (비-Marketplace 가정)

**전제:** CHOIR를 **비-Marketplace 승인 앱**으로 가정. Slack 2025 변경으로 `conversations.history`/`replies`가 **분당 1회·응답 15객체**로 강제됨. (승인 앱이면 면제되나, 안전하게 비승인 기준으로 설계.)

### 설계 정합 (구현 시 반드시)
- **단일 페이지 원칙**: `conversations.*`에 절대 15 초과 요청하지 않고 **페이지네이션 안 함**. cap 15가 Slack 신규 한도와 정렬됨. "90분 OR 15개"는 *한 번의 호출 안에서* best-effort.
- **호출 상한**: 답글 멘션은 `conversations.replies`(스레드) + `conversations.history`(부모 이전) **최대 2회**. 비-스레드는 history 1회.
- **graceful degrade**: `conversations.*`를 `safeSlackCall`로 감싸 429 시 **부분 결과 + "잠시 트래픽 많음" 안내**([rate-limit-handler](../services/slack/rate-limit-handler.ts))로. 1~3분 hang 방지.
- (선택) **ConversationCache 부활**: 같은 트리거 재시도/연타 시 재fetch 방지(짧은 TTL).

### ✅ 버그성 낭비 제거 (구현 완료, 설계와 독립)
- **`auth.test` 폭증 제거**: `processMessageText`가 메시지마다 `auth.test()`를 부르던 것(메시지당 2회 패스 × N) → bot id를 **호출처에서 1회만 구해 전달** + **멘션 없으면 조기 반환**(API 0회). `services/slack/conversation-history.ts`.
- **`isBotUser` 캐시**: 멘션마다 `users.info` 부르던 N+1 → 모듈 캐시(`Map<userId, boolean>`). `services/slack/user-management.ts`.

## 6. 다음 단계

1. 남은 C7(마커 견고성)만 정하면 수집부 설계 closed.
2. 프롬프트 v4(부록 A)를 `knowledge-extractor.ts`에 반영 + 대화 시각 주입 배선 + **D9 컷 제거**.
3. 수집부(시간갭·cap·부모이전·위치규칙) 구현 — §5 단일 페이지·호출 상한 준수.
4. 경량 LLM 선택기 + 체크박스 UI (C3·C4).

---

## 부록 A. 확정 추출 프롬프트 (v4, 코드 반영용 원문)

```text
You are CHOIR, a documentation specialist. Extract organizational knowledge from the conversation that should be saved for future reference.

WHAT TO EXTRACT
- Only settled, factual organizational knowledge: established policies, procedures, decisions that have actually been made, or reusable reference facts.
- Do NOT extract casual conversation, personal preferences, or proposals/opinions that are still being debated or not yet decided.
- If people are still discussing or disagreeing and no decision has been reached, respond with exactly: No organizational knowledge found

GROUNDING (prefer holding back over guessing)
- Use only facts directly stated in the conversation messages or in the provided current-documentation context. Never invent or infer details that are not present.
- If the conversation only refers to content that is not actually contained in the messages (for example "save what I described above" but that description is not present), do NOT fabricate a summary. Respond with exactly: No organizational knowledge found

CORRECTIONS
- When CHOIR's recent answer is provided, treat it as the current documentation state. If the conversation changes, replaces, updates, increases, decreases, or corrects a value from it, document the resulting updated fact using the subject from that answer.

TIME
- The conversation date is given in the Organizational Context. Convert every relative time expression (for example "next Monday", "next week", "next month", "tomorrow") into an absolute date in YYYY-MM-DD form based on that date. Keep genuinely recurring expressions (for example "the 5th of each month") as recurring. Do not leave relative time expressions in the output.

OUTPUT
- Write in the SAME language as the conversation. If the conversation is in Korean, write the output in Korean.
- Start with a descriptive markdown title (# [Topic]), then write the information as natural short paragraphs. Do not use bullet or numbered lists.
- Do not add explanations, interpretations, or implications. Do not attribute information to specific people. Always preserve any URLs.
```

추가 주입: Organizational Context에 `- Conversation date: <YYYY-MM-DD> (<Weekday>, <TZ>)` 한 줄.

## 부록 B. before → after 실측 예시 (gpt-5.4-mini)

| 케이스 | 현재 | 개선(v4 방향) |
|---|---|---|
| 한국어 회의실예약 | 영어 출력 | 한국어 출력 |
| 배포 절차(답변 이전) | "절차가 설명되었고 저장 요청됨"(내용 없음) | 컷 제거 시 실제 절차 단락 / 컷 유지 시 보류 |
| 미합의 코드리뷰 토론 | 제안을 정책처럼 문서화 | `No organizational knowledge found` |
| "다음 달부터" 경비마감 | 상대표현 그대로 | `2026-07-01부터` |
| 휴가 15→20 정정 | 정상 | 정상(유지) |

## 부록 C. 경량 선택기 프롬프트 (nano, 구조화 출력)

후보 메시지 중 **default로 체크할 것**을 고르는 nano 선택기. 출력 = 포함할 메시지 번호 배열. 위치 게이트(D5)는 코드에서 적용.

```text
[system]
You help a teammate pick which Slack messages to include when documenting team knowledge.
You are given the user's documentation request and a numbered list of recent messages.
Decide which messages are part of the SAME topic the user wants documented.

Include a message if it states facts, decisions, policies, numbers, names, links, or context about that topic.
Exclude greetings, reactions, jokes, scheduling chit-chat, and messages about a different subject.
This only sets the default selection — the user can adjust it afterward. When a message is clearly on the same topic, include it.

Return only the numbers of the messages to include by default.

[user]
Documentation request:
{triggerText}

Messages:
[1] {Name}: {text}
[2] {Name}: {text}
...

Return the message numbers to include by default.
```

구조화 스키마:
```json
{ "type": "object", "additionalProperties": false,
  "properties": { "include": { "type": "array", "items": { "type": "integer" } } },
  "required": ["include"] }
```

코드 결합 규칙:
- 스레드(부모+답글): `default = include에 포함?` (LLM이 잡담을 빼면 해제)
- 부모 이전 버스트: 이른 mention(≤2)이면 `default = include 포함 여부`, 늦으면 `default = false`(사용자 수동 체크 가능)
- 비-CHOIR 메시지: 후보에서 제외(disabled 표시)

## 부록 D. 관련 env 키

| 키 | 기본값 | 용도 |
|---|---|---|
| `EXTRACTION_TIME_GAP_MINUTES` | 30 | 버스트를 끊는 침묵 갭 |
| `EXTRACTION_MAX_LOOKBACK_MINUTES` | 90 | back-scan 시간 cap |
| `EXTRACTION_MAX_CANDIDATE_MESSAGES` | 15 | back-scan 개수 cap |
| `DEFAULT_TIMEZONE` | America/New_York | 트리거 유저 tz 없을 때 fallback (미 동부, EST/EDT) |
