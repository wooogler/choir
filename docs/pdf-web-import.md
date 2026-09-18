# PDF · 웹페이지 import — 새 저장소 문서로 변환해 들여오기

> 상태: **P0·P1·P2 구현 완료 (2026-09-18)**. 아래 "구현 현황"이 실제 코드와 계획의 차이를 적는다. P3는 미착수.

## 구현 현황 (2026-09-18)

한 세션에서 오케스트레이터(Fable) + Opus 서브 에이전트 7개로 병렬 구현했다. 실제 파일 배치는 아래 "코드 배치" 절의 계획과 조금 다르다:

- `services/import/` — `types.ts`(공용 계약), `draft-store.ts`, `upload-store.ts`(PDF 업로드 → 견적 확인 사이의 바이트 보관), `commit-guard.ts`, `source-note.ts`(`<!-- choir:source -->` 마커), `progress.ts`, `mutex.ts`(워크스페이스당 변환 1개, 대기 없이 `import_busy`), `config.ts`, `routes.ts`.
- `services/import/sources/pdf/` — 계획의 `gate.ts`는 `inspect.ts`(pdfjs 텍스트·이미지 XObject·공백 페이지) + `plan.ts`(청크·detail) + `chunk.ts`(pdf-lib) + `estimate.ts`(무료 토큰 카운트 + 가격표)로 나뉘었다. `prompt.ts`는 스캔 페이지가 있으면 스캔 전용 문장을 덧붙인다. 요청에 `reasoning.effort: 'low'`.
- `services/import/sources/web/` — 계획대로. Readability 결과가 500자 미만이면 본문 fallback, HTML 주석 제거, 헤딩 안 permalink 앵커 제거, 표 셀 안 블록 평탄화, 코드 언어를 `pre`/래퍼 클래스에서도 추출.
- 착지는 `createDocument`(assets · provenance `source.import` · `onStep` · `skipReplicaPublish`). gdocs import도 그 위로 옮겨 인덱스 갱신 누락이 고쳐졌고 `new-file` 사이드카를 쓴다.
- API는 계획과 한 가지 다르다: PDF는 `POST /import/pdf`(업로드 + 견적 JSON) → `POST /import/pdf/:uploadId/convert`(NDJSON) 두 단계다. 견적을 사람이 확인한 뒤에 유료 호출이 나가게 하기 위해서다.
- 옮기지 않은 것: `services/google/import-steps.ts`, `import-path.ts`는 그대로 두고 재사용했다(뷰어 step 카탈로그가 그 어휘를 쓴다).
- 웹 UI: `ImportMenu.tsx`(Google Docs / PDF / URL), `PdfEstimateDialog.tsx`, `ImportPreviewDialog.tsx`(CrepeEditor), `ImportProgress.tsx`, `utils/import-api.ts`. Google Docs import 버튼은 이제 메뉴 안에 있어 `import/status`가 허용한 관리자에게만 보인다.
- 테스트: `__tests__/import-*.test.ts` 22개 스위트. jest는 CommonJS라 pdfjs·jsdom 29를 직접 못 읽어, 두 테스트가 Node 22의 `require(esm)`을 우회 호출해 실제 라이브러리를 쓴다. 정공법은 jest ESM 전환.
- 라이브 확인: GitHub README 페이지 URL(2.1초, 헤딩·코드 언어 보존)과 3쪽 PDF(견적 1,750 입력 토큰 ≈ $0.004, 10.7초, 경고 없음).

Google Docs import(`services/google/import-service.ts`)가 하는 일 — Picker로 고른 Doc을 **새 `.md` 문서로 커밋** — 을 두 가지 소스에서 더 할 수 있게 한다.

| 소스 | 입력 | 변환 |
| --- | --- | --- |
| PDF | 뷰어에서 파일 업로드 | OpenAI Responses API `input_file`(텍스트 + 페이지 이미지) → markdown. pdfjs는 게이트·검증·fallback |
| 웹페이지 | 공개 URL 하나 | fetch → Readability → HTML→markdown(unified). LLM 없음 |

진입점은 뷰어 사이드바의 기존 `Import from Google Docs` 자리. 세 소스를 한 메뉴로 묶는다.

## Google Docs import와 같은 점 / 다른 점

같은 점 (그대로 재사용):

- 관리자만. 세션은 `requireManagerOf`.
- **덮어쓰지 않는다.** 대상 경로가 있으면 `exists`. import가 기존 문서를 교체하면 리뷰를 우회하는 것과 같다.
- 경로 검증은 `normalizeImportPath` (repo 상대 `.md`, `..`·`assets/`·`.choir/` 금지).
- 이미지는 content-addressed `assets/<hash>.<ext>` 로, 본문과 같은 커밋. 거부된 이미지는 참조째 제거하고 `RejectedAsset`으로 보고.
- provenance 사이드카 없음 (이유는 gdocs 문서의 설명 그대로: 기록은 변경의 *이유*이고 import에는 그게 없다).
- 진행 상황은 NDJSON 스트림 (`application/x-ndjson`, `readNdjson`).

다른 점 (이 문서가 새로 정하는 것):

1. **커밋 전에 미리보기·편집 단계가 있다.** Docs export는 정확해서 바로 커밋해도 됐지만, PDF·웹 변환은 손실과 해석을 동반한다. 관리자가 커밋될 내용을 보고 고칠 수 있어야 한다. → 2단계 API(convert → commit)와 draft.
2. **원본과 연결(replica)하지 않는다.** PDF는 정적이고, 웹페이지는 우리가 쓸 수 없다. 대신 본문 머리에 출처 한 줄을 남긴다.
3. **인덱스를 import가 직접 갱신한다.** gdocs import는 커밋+미러만 하고 `vectorStore`/QMD 갱신을 하지 않았다(`save-document.ts`는 한다). 착지를 `createDocument`로 합치면서 gdocs 경로도 같이 고쳤다(2026-09-18).

## 확정된 설계 결정 (P0 결과로만 재논의)

### 1. 착지는 뷰어의 "New document" 경로(`createDocument`)를 확장해 공유 — **구현됨 (2026-09-18)**

`services/docs-editor/create-document.ts`가 "새 문서 착지"다: `normalizeDocumentPath`(gdocs `import-path`가 이걸 위임) → exists 검사(미러 + 디스크 + **GitHub**) → `saveEditedDocument`(커밋 · provenance `new-file` · 미러 · **인덱스 갱신** · replica publish). 세 번째 착지 경로를 만들지 않고 이것을 쓴다.

구현된 시그니처:

```ts
createDocument(params: {
  workspaceId; userId; filePath;
  content?; commitMessage?;
  assets?: ImportAsset[];                 // 같은 커밋 + 미러
  source?: ProvenanceRecord['source'];    // { editor: 'web' } 위에 merge
  onStep?: (step: 'checking' | 'committing' | 'mirroring' | 'indexing' | 'done') => void;
  skipReplicaPublish?: boolean;           // gdocs import 전용 (아래)
}): Promise<{ commitSha, filePath }>
```

- `assets`는 markdown과 **같은 커밋**에 base64로 실리고(`commitFilesWithContext`), 미러에도 쓰인다. asset 경로는 content-addressed이므로 미러에 이미 있으면 쓰기는 건너뛴다 — 같은 bytes다. 커밋에는 그대로 포함해도 안전하다(blob sha가 같아 트리 항목이 변하지 않는다). `assets/` 밖을 가리키는 경로는 커밋 전에 거부한다.
- provenance `source`는 `{ editor: 'web' }`이 기본이고 import가 `{ import: 'pdf' | 'url' | 'google-docs', name, url?, pages?, fileId? }`를 얹는다. `new-file` 타입 덕분에 "문서 전체를 변경 목록으로 되읊는" 문제(gdocs가 사이드카를 거부했던 이유)가 사라졌으므로 **세 소스 모두 사이드카를 쓴다**. gdocs의 "사이드카 없음" 결정은 이때 뒤집혔다 — docs/google-drive-sync.md "Docs → 저장소 import" 참고.
- `onStep`은 best-effort다: 던지는 리스너가 저장을 깨뜨리지 않는다(`makeStepReporter`, `import-steps.ts`의 `makeProgressReporter`와 같은 이유).

`services/google/import-service.ts`는 "export 읽기 → `extractImportable` → `createDocument({ content, assets, commitMessage, source, onStep })` → replica 연결"로 줄었고, 빠져 있던 인덱스 갱신도 따라왔다. 이 경로만 `skipReplicaPublish: true`를 넘긴다: 착지 직후 `preserve` 모드로 연결할 문서에 publish가 끼어들면 Doc이 이미 가진 내용을 "직접 반영하라"는 요청으로 올린다(PDF·URL은 연결된 Doc이 없어 기본값 그대로도 no-op). gdocs step 어휘는 그대로라, 착지의 `committing`/`mirroring`만 전달하고 `indexing`은 흘린다. `import-steps.ts`는 `services/import/`로 옮기고 기존 경로에서 재export.

### 2. 2단계 API + 서버 메모리 draft

- `POST /api/docs/:ws/import/pdf` — raw `application/pdf`, 파일명은 `X-Import-Filename`(RFC 5987 인코딩).
- `POST /api/docs/:ws/import/url` — JSON `{ url }`.
- 둘 다 NDJSON으로 `progress` 라인을 흘리고 마지막에
  `{ type:'result', draftId, markdown, title, suggestedPath, warnings[], assets:[{ path, bytes, contentType }], source:{ kind:'pdf'|'url', name, pages? } }`.
- `POST /api/docs/:ws/import/commit` — JSON `{ draftId, filePath, markdown }` → `createDocument({ content, assets })` → `{ githubPath, commitSha, rejectedAssets }`.
- draft(`draft-store.ts`): 메모리 `Map`, TTL 15분, `workspaceId + userId`에 바인딩(picker nonce와 같은 이유 — 남의 draft를 커밋할 수 없다), 이미지 bytes 포함. 총량 상한(기본 50MB) 넘으면 오래된 것부터 제거. 프로세스 재시작 시 사라지는 건 정상(사용자는 다시 변환).
- commit의 `markdown`은 클라이언트가 편집한 결과다. 본문의 `assets/…` 참조는 **draft에 있는 것만** 허용하고, 그 외는 참조 제거 + `rejectedAssets`로 보고. 참조되지 않은 draft asset은 커밋하지 않는다.

### 3. 미리보기는 기존 `CrepeEditor` 재사용

`ImportPreviewDialog`: 왼쪽에 Crepe 편집기(변환된 markdown, 편집 가능), 위에 경로 입력(`suggestedPath` 프리필, `looksLikeRepoPath` 검사), 경고 목록(fidelity 낮음, 거부된 이미지, 잘린 내용), `Import`/`Cancel`. 이미지는 draft asset을 미리보기용 임시 URL(`/api/docs/:ws/import/draft/:id/asset/:path`, 소유자만)로 보여준다.

편집 후 커밋이 거의 공짜로 따라온다. 별도 "편집 없이 바로 커밋" 모드는 두지 않는다.

### 4. PDF 변환 = LLM 1차, pdfjs는 게이트·검증·fallback

문서 확인(2026-09-18, developers.openai.com/api/docs/guides/file-inputs):
Responses API `input_file`은 PDF에서 **텍스트와 페이지 이미지를 둘 다** 추출해 vision 모델에 준다. 요청당 파일 합계 **50MB 미만**. `detail: 'low'|'high'|'auto'`로 페이지 이미지 토큰을 조절. 스캔 PDF(텍스트 레이어 없음)도 페이지 이미지로 읽히므로 별도 OCR이 필요 없다.

- `sources/pdf/gate.ts` (pdfjs-dist legacy build, canvas 없음): 페이지 수·암호화·텍스트 유무·메타 title. 한도 초과(`IMPORT_PDF_MAX_PAGES`, 기본 40 / `IMPORT_PDF_MAX_BYTES`, 기본 20MB)나 암호화 PDF는 여기서 거부.
- `sources/pdf/llm-convert.ts`: `resolveLLMConfig(ws, 'qa')`(이미 vision 모델을 쓰는 경로) + `client.responses.create` with `input_file(file_data: base64, detail)`. 프롬프트 원칙은 **전사(transcribe)**: 요약·재서술·번역 금지, 문서 언어 유지, 헤딩 구조 복원, 표는 GFM, 그림·도표는 `> [그림: 한 줄 설명]`, 머리말·쪽번호·반복 헤더 제거, 출력은 markdown만(코드펜스로 감싸면 벗긴다).

#### 토큰 비용 — 긴 문서 대책 (P0 실측 2026-09-18, `scripts/spike-import/RESULTS.md`)

가격(gpt-5.4-mini, 프로젝트 기본 모델, 1M 토큰당): 입력 $0.75 / 출력 $4.50. Flex 처리(`service_tier: 'flex'`)는 둘 다 절반. 스파이크에서 `POST /v1/responses/input_tokens`(무료)와 실제 변환 7회(총 $0.056)로 잰 값:

| 페이지당 | 실측 |
| --- | --- |
| 텍스트 페이지 입력 | ≈ 470 토큰 — `low`·`high` 동일. API는 순수 텍스트 페이지를 이미지로 만들지 않는다 |
| 벡터 그래픽이 있는 페이지 | `high`에서만 +1,881 토큰(고정). `low`는 텍스트만 |
| 내장 래스터 이미지 페이지 | ≈ 630(`low`) / ≈ 1,500(`high`) |
| 출력 (markdown) | 460~540 토큰 (≈ 0.22 토큰/문자). 비용의 약 85% |
| 비용 (`low` + flex) | ≈ $0.0013/쪽 → 40쪽 ≈ $0.05, 300쪽 ≈ $0.4 |
| 속도 | ≈ 2.9초/쪽 (19쪽 단일 호출 55초, 잘림 없음, 충실도 0.987) |

검증된 사실들: `high`는 텍스트 페이지에서 결과가 동일하고(헤딩 8·표 행 6 모두 같음) 돈만 2.5배. Flex는 6/6 수락, 429 없음. 코드펜스 감싸기·거부·잘림 없음. **스캔 페이지는 `high`만으로는 안 되고** "이 이미지는 문서 스캔이니 텍스트를 전사하라"는 프롬프트 문장이 필요하다(없으면 `> [그림: …]` 한 줄로 요약해 버린다). 텍스트도 이미지도 없는 벡터 전용 페이지는 빈 문자열로 변환되므로 게이트에서 거른다. 400k 토큰 상한은 텍스트 약 850쪽에 해당해 실제로는 페이지 한도가 먼저 걸린다.

즉 **돈은 문서 하나에 몇 십 원 수준**이고, 긴 문서의 진짜 제약은 **한 요청의 시간**이다(40쪽 ≈ 2분). 그래서 결정:

1. **페이지 단위 라우팅.** pdfjs 텍스트 레이어가 충분한 페이지(문자 수 임계값 이상)는 `detail: low` — 텍스트는 이미 추출돼 들어가니 이미지는 구조(헤딩·표) 힌트만 주면 된다. 텍스트가 거의 없고 이미지가 있는(스캔) 페이지만 `detail: high` + 스캔 전용 프롬프트 문장. 한 문서 안에 섞여 있으면 청크를 그 기준으로 나눈다. `IMPORT_PDF_DETAIL`은 이 자동 판정의 override.
2. **사전 견적을 미리보기 전에 보여준다.** 게이트 단계에서 `inputTokens.count`로 입력 토큰을 재고, 출력은 추출 텍스트 길이로 추정해 "N쪽, 약 X천 토큰, 약 $Y" 를 확인 대화상자에 표시한다. 상한 `IMPORT_PDF_MAX_INPUT_TOKENS`(기본 400k) 초과는 `import_too_many_tokens`로 거부하고 페이지 범위를 좁혀 다시 올리라고 안내한다. 견적 호출 자체는 무료다.
3. **청킹은 P2에 포함**(P3에서 앞당김). `pdf-lib`으로 15~20쪽 범위를 잘라 순차 호출, 각 청크에 "이전 청크의 마지막 헤딩 경로"를 힌트로 넘겨 구조를 이어 붙인다. 청크마다 progress 라인을 흘려 진행률이 보이게. 한도는 `IMPORT_PDF_MAX_PAGES` 기본 40 → **200**으로 올리되 토큰 상한이 실제 제한이 된다.
4. **Flex 처리 기본.** import는 대화형 답변이 아니라 "기다릴 수 있는" 작업이므로 `service_tier: 'flex'`로 절반 가격에 보내고, 자원 부족(429)이면 표준 처리로 재시도. 타임아웃은 청크당 5분.
5. **텍스트형 PDF에 LLM을 아예 안 쓰는 옵션**은 `IMPORT_PDF_MODE=text`로 남겨두되 기본은 아니다. pdfjs 텍스트만으로는 표·다단·헤딩 계층이 무너져 검색 품질이 떨어지고, 그 비용(문서당 몇 백 원)은 아낄 가치가 없다. P0에서 텍스트형 샘플의 결정적 변환 결과가 충분히 좋으면 이 결정을 뒤집는다.
- `sources/pdf/fidelity.ts` (순수 함수): pdfjs가 뽑은 텍스트의 문자 n-gram 중 출력 markdown에 살아있는 비율. 텍스트 PDF에서 임계값(기본 0.85) 아래면 `warnings`에 `low_fidelity`. **막지 않는다** — 미리보기에서 사람이 판단한다. 스캔 PDF(추출 텍스트 거의 없음)는 검사 생략하고 `scanned` 경고만.
- `sources/pdf/text-fallback.ts`: LLM이 꺼져 있거나(`IMPORT_PDF_MODE=text`) 실패하면 pdfjs 텍스트를 줄 간격·글자 크기 기준으로 단락/헤딩만 나눈 단순 markdown. 스캔 PDF는 이 모드에서 `import_pdf_no_text`.
- PDF 안의 **이미지는 assets로 추출하지 않는다** (아래 Non-goals). 그림은 설명 줄로 대체된다.

### 5. 웹 변환 = 결정적 파이프라인, LLM 없음

- `sources/web/fetch-page.ts`: `fetch-url-text.ts`의 SSRF 가드·수동 redirect·크기 캡(`assertPublicUrl`, `fetchFollowingPublicRedirects`, `readBodyCapped`)을 export로 승격해 그대로 사용. HTML만, `IMPORT_WEB_MAX_BYTES` 기본 5MB, 타임아웃 15초.
- `sources/web/html-to-markdown.ts` (순수: HTML 문자열 + base URL → markdown): JSDOM → Readability `.content`(비면 `<main>` → `<article>` → `<body>` 순 fallback) → `rehype-parse` → `rehype-remark`(GFM 표 포함) → `remark-stringify`. 상대 링크·이미지 URL은 절대 URL로. `script`/`style`/`nav`/`footer` 등은 Readability와 hast 단계에서 제거.
- `sources/web/collect-images.ts`: `<img src>` → 기존 `fetchRemoteImage`(SSRF·타입 allowlist·크기 캡) → `DeltaAsset`. 최대 `IMPORT_WEB_MAX_IMAGES`(기본 20), 총 10MB. 거부는 참조 제거 + `RejectedAsset`.
- 결과가 비면 `import_url_unreadable` — 안내: "JS로 렌더링되는 페이지는 브라우저에서 PDF로 저장해 올리세요". 403/429는 `import_url_blocked`.
- 웹 변환에 LLM을 끼우지 않는 이유: 결정적 결과가 곧 충실도다. 정리가 필요하면 미리보기 편집기에서 한다.

### 6. 출처 기록

- 커밋 메시지: `Import <basename> from PDF (<원본 파일명>, N pages)` / `Import <basename> from <hostname>`.
- 본문 첫 줄에 blockquote 한 줄(`source-note.ts`, 워크스페이스 언어로): `> 출처: https://… (2026-09-18 가져옴)` / `> 출처: onboarding.pdf (12쪽, 2026-09-18 가져옴)`. 독자가 원문으로 갈 수 있고, 인덱스에도 들어간다. 미리보기에서 지울 수 있다.
- 원본 PDF는 저장소에 넣지 않는다(assets는 이미지만, 저장소 비대화). 옵션으로 남긴다(P3).
- provenance 사이드카(`new-file`)의 `source`에도 같은 출처가 들어간다: `{ editor: 'web', import, name, url?, pages?, fileId? }`. 커밋 메시지·본문 한 줄과 달리 이건 지워지지 않고 남는 기계가 읽는 기록이다(결정 1 참고).

### 7. 한도와 동시성

워크스페이스당 변환 동시 1개(`KeyedMutex` — `services/google/keyed-mutex.ts`를 `services/common/`으로 이동). 변환 중 같은 워크스페이스의 두 번째 요청은 `import_busy`(409). 크기·페이지 한도는 위 항목대로. LLM 호출은 워크스페이스 OpenAI 키로 과금되므로 미리보기 결과에 페이지 수를 보여준다.

## Non-goals — 만들지 말 것

- 사이트 크롤링(여러 페이지), 로그인이 필요한 페이지, headless 브라우저로 JS 렌더링.
- PDF 안의 이미지·도표를 assets로 추출.
- Google Docs처럼 원본과의 동기화(replica/drift/review). 정적 소스다.
- 기존 문서에 병합/덮어쓰기. 기존 문서를 고치려면 import 후 편집기에서 복사한다.
- Slack 쪽 진입점(DM에 PDF 올리기) — P3 옵션.
- 변환 결과의 LLM "다듬기". 전사만 한다.

## 코드 배치

```
services/docs-editor/
  create-document.ts        # (진행 중) 착지. assets 인자 추가
  save-document.ts          # (진행 중) assets를 같은 커밋·미러에, provenance source에 import 출처
services/import/
  index.ts
  import-steps.ts           # services/google에서 이동 + 소스별 step 목록
  draft-store.ts            # 메모리 draft, TTL, 사용자 바인딩, 총량 상한
  source-note.ts            # 출처 blockquote (i18n)
  routes.ts                 # /import/pdf, /import/url, /import/commit, draft asset 미리보기
  sources/pdf/
    gate.ts                 # pdfjs: 페이지 수·암호화·텍스트·title
    llm-convert.ts          # Responses API input_file → markdown
    prompt.ts
    fidelity.ts             # n-gram 커버리지 (순수)
    text-fallback.ts        # pdfjs 텍스트 → 단순 markdown
  sources/web/
    fetch-page.ts           # fetch-url-text의 가드 재사용
    html-to-markdown.ts     # Readability → rehype-remark (순수)
    collect-images.ts       # img → fetchRemoteImage → DeltaAsset
services/google/import-service.ts   # export 읽기 + extractImportable + createDocument + replica 연결로 축소
services/docs-editor/api-errors.ts  # 새 코드 추가 (아래)
web/src/components/
  ImportMenu.tsx            # 사이드바 항목: Google Docs / PDF 파일 / 웹 URL (GoogleDocsImport 흡수)
  ImportPreviewDialog.tsx   # CrepeEditor + 경로 + 경고 + Import
web/src/i18n/locales/{en,ko}.ts, web/src/i18n/server-errors.ts
docs/pdf-web-import.md      # 이 문서 → 구현 후 레퍼런스로 갱신
```

### 진행 step 어휘

`ImportProgress`의 `step` 키로 클라이언트가 라벨을 고르는 구조(`STEP_KEY`)는 그대로. step 집합만 소스별로:

| 단계 | gdocs | pdf | url | commit |
| --- | --- | --- | --- | --- |
| checking | ✓ | ✓ (게이트) | ✓ (URL 검증) | ✓ (경로·exists) |
| reading / fetching | reading | — | fetching | — |
| converting | — | ✓ (LLM) | ✓ | — |
| ready | — | ✓ | ✓ | — |
| committing / mirroring / indexing / linking / done | ✓ (linking은 gdocs만) | — | — | ✓ |

### 오류 코드 (api-errors.ts에 추가, drift 테스트가 강제)

`import_busy`, `import_unsupported_file`, `import_too_large`, `import_too_many_pages`, `import_too_many_tokens`, `import_pdf_encrypted`, `import_pdf_no_text`, `import_url_invalid`, `import_url_blocked`, `import_url_unreadable`, `import_conversion_failed`, `import_draft_expired`, `import_llm_unavailable`.

### 설정

| env | 기본 | 뜻 |
| --- | --- | --- |
| `IMPORT_PDF_MAX_BYTES` | 20MB | 업로드 상한 (라우트 `express.raw` limit과 동일) |
| `IMPORT_PDF_MAX_PAGES` | 200 | 게이트. 실제 제한은 아래 토큰 상한 |
| `IMPORT_PDF_MAX_INPUT_TOKENS` | 400000 | 사전 견적(`inputTokens.count`) 초과 시 거부 |
| `IMPORT_PDF_CHUNK_PAGES` | 20 | 청크당 페이지 수 |
| `IMPORT_PDF_DETAIL` | `auto` | `auto`(페이지별: 텍스트 있으면 low, 스캔이면 high) / `low` / `high` |
| `IMPORT_PDF_SERVICE_TIER` | `flex` | `flex`(절반 가격, 429 시 표준 재시도) / `default` |
| `IMPORT_PDF_MODE` | `auto` | `auto`(LLM, 실패 시 text) / `llm` / `text` |
| `IMPORT_WEB_MAX_BYTES` | 5MB | HTML 캡 |
| `IMPORT_WEB_MAX_IMAGES` | 20 | 페이지당 이미지 |
| `IMPORT_DRAFT_TTL_MIN` | 15 | draft 수명 |

배포 노트: nginx `client_max_body_size ≥ 20m`, `proxy_read_timeout ≥ 180s` (40p `high` 변환은 1~2분 걸릴 수 있다 — P0에서 실측). PM2 인스턴스별 draft 메모리 최대 50MB.

### 의존성

- `pdfjs-dist` — legacy build를 Node 22에서 canvas 없이 텍스트·메타만. (P0에서 `DOMMatrix` 경고 등 확인)
- `pdf-lib` — 페이지 범위를 잘라 청크 PDF를 만드는 용도(순수 JS, pdfjs는 쓰기를 못 한다).
- `rehype-parse`, `rehype-remark`, `remark-gfm`, `remark-stringify` — `unified`/`remark-parse`는 이미 있다.

검토 후 제외: `turndown`(+gfm 플러그인) — 더 단순하지만 unified 스택과 이질적이고 mdast를 못 얻는다. `pdf-parse`/`unpdf` — pdfjs 래퍼, 직접 쓰는 것과 차이 없음. pandoc/marker/docling 등 외부 CLI — 배포 이미지 부담.

## 단계

### P0 — 스파이크 (0.5일) `scripts/spike-import/`

1. 샘플 PDF 3종(텍스트형 한국어 규정, 스캔형, 표 많은 영문)을 Responses API `input_file`로 변환: 토큰·시간·비용·fidelity 점수 기록. `detail` low/high 비교. **페이지당 실제 입력 토큰을 `responses.inputTokens.count`로 재서 위 표의 추정치를 교체**하고, 텍스트형 페이지에 `low`가 구조(헤딩·표)를 충분히 살리는지 확인. Flex 처리의 지연·429 빈도도 기록.
2. `pdfjs-dist` legacy build가 Node 22에서 canvas 없이 `getTextContent`/`numPages`/암호화 감지가 되는지.
3. `rehype-remark` 결과 3사이트(GitHub README 페이지, 대학 규정 HTML, Notion 공개 페이지): 헤딩·목록·표·코드·이미지 보존 여부.

판정: 텍스트형 fidelity ≥ 0.9, 40p 변환 < 120초, 웹은 표·목록·헤딩 보존. 미달 항목은 위 결정을 바꾼다(예: `high` → `auto`, 한도 축소, turndown 전환).

### P1 — 공통 착지 + URL import (1.5일)

- "New document" 세션의 `createDocument`/`saveEditedDocument`가 main에 오른 뒤 시작. `assets` 인자와 provenance `source.import` 추가, gdocs import를 `createDocument` 위로 옮김(테스트: 기존 커밋 파일 목록 동일 + 인덱스 갱신 호출). gdocs 사이드카 여부 결정.
- `draft-store`, `/import/url`, `/import/commit`, draft asset 미리보기 라우트.
- `ImportMenu` + `ImportPreviewDialog`(Crepe), 기존 `GoogleDocsImport` 흡수.
- i18n(en/ko), api-errors + server-errors, drift 테스트.
- `docs/google-drive-sync.md`의 import 절에 공통 착지 언급, `docs/architecture.md` 서비스 목록.

### P2 — PDF import (1.5~2일)

- `gate`(페이지별 텍스트 유무 → detail 판정, `inputTokens.count` 견적), `llm-convert`(pdf-lib 청킹 + 청크 간 헤딩 힌트 + flex), `prompt`, `fidelity`, `text-fallback`, `/import/pdf`(raw body).
- 메뉴에 파일 선택 → **견적 확인 대화상자**(쪽수·토큰·예상 비용) → 변환. 미리보기에 fidelity·scanned 경고.
- 테스트(아래), 이 문서를 레퍼런스로 갱신.

### P3 — 선택

- Slack DM에 PDF를 올리면 "문서로 가져올까요?" 카드 → 같은 convert/commit(Slack 모달은 미리보기가 약하므로 뷰어 링크로 넘긴다).
- 원본 PDF를 `assets/`에 보관하는 옵션.
- `.docx`/`.pptx` 업로드 — Responses API가 같은 `input_file`로 받는다(텍스트만 추출). 게이트만 다르고 파이프라인은 PDF와 같다.

## 테스트 계획

순수 함수 위주(기존 `__tests__/gdocs-import.test.ts` 방식):

- `html-to-markdown`: 픽스처 HTML → 기대 markdown. 헤딩·중첩 목록·GFM 표·코드블록·상대 링크 절대화·`script`/`nav` 제거·`img` 자리표시.
- `fidelity`: 같은 텍스트 1.0, 요약본 ≈ 0.3, 표 셀 순서 바뀐 것은 통과, 빈 추출 텍스트는 검사 생략.
- `draft-store`: TTL 만료, 다른 사용자·워크스페이스 접근 거부, 총량 상한 시 오래된 것 제거.
- `source-note`: en/ko, URL/PDF 두 형태.
- `gate`: `__tests__/fixtures/`의 작은 텍스트 PDF(페이지 수·텍스트 있음), 암호화 PDF 거부, 페이지 한도.
- `land-document`: GithubService·mirror·vectorStore mock — exists 거부, 커밋 파일 목록(md + 참조된 assets만), 인덱스 갱신·warmup 호출.
- commit 검증: draft에 없는 `assets/` 참조 제거 + 보고.
- `llm-convert`: client mock — 프롬프트에 언어·전사 지시 포함, 빈 출력 실패, 코드펜스 벗기기, `import_llm_unavailable` 경로.
- `docs-api-errors` drift 테스트에 새 코드.
- gdocs import 회귀: 리팩터 전후 커밋 파일 목록 동일.

## 리스크와 전제

- **LLM이 내용을 바꾸거나 빠뜨림.** fidelity 경고 + 미리보기 편집이 방어선. 경고를 무시하고 커밋할 수 있다 — 관리자의 판단이다.
- **비용.** 추정으로는 문서당 몇 십 원~몇 천 원(위 표)이지만 페이지 이미지 토큰은 실측 전이다. 사전 견적·토큰 상한·페이지별 `low`·Flex가 방어선이고, 견적을 사람이 보고 진행한다. 워크스페이스 키로 과금된다는 점을 견적 문구에 적는다.
- **메모리.** draft에 이미지 bytes. 총량 상한·TTL로 묶는다.
- **웹: JS 렌더링·봇 차단.** 헤드리스 브라우저는 안 한다. 명확한 오류와 "PDF로 저장해 업로드" 우회 안내.
- **프록시 한도.** body 크기·읽기 타임아웃을 배포 노트로.
- **pdfjs on Node.** legacy build 필요. P0에서 확인.
- **SSRF.** 기존 가드 재사용. DNS rebinding TOCTOU는 기존과 같은 위협 모델(관리자가 넣는 URL)로 수용.
