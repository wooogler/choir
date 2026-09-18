# Spike: PDF · 웹페이지 import (P0)

`docs/pdf-web-import.md` 의 P0 항목을 실측하기 위한 스파이크입니다. 제품 코드가 아니며
어디에도 연결되어 있지 않습니다. 결과는 [RESULTS.md](RESULTS.md).

측정한 것:

1. `input_file` PDF의 **실제 입력 토큰** — `POST /v1/responses/input_tokens`(무료)로
   샘플 × `detail` × 모델 전 조합. 계획서의 추정 표를 대체합니다.
2. **실제 변환** 7건 (gpt-5.4-mini) — 시간·토큰·비용·fidelity, 그리고 사람이 헤딩·표
   품질을 볼 수 있게 markdown 원본.
3. **웹 변환** — Readability → rehype-remark 파이프라인을 실제 공개 페이지 4곳에.
4. **pdfjs** legacy build가 Node 22에서 canvas 없이 도는지, 글자 `height`가 헤딩 신호로
   쓸 만한지.

전체 지출: **$0.056**.

## 파일

| 파일 | 역할 |
| --- | --- |
| `spike-common.ts` | 공용: `.env` 로딩, OpenAI 클라이언트, `input_tokens` 호출, pdfjs 텍스트/height 추출, pdf-lib 페이지 슬라이스, fidelity(문자 5-gram), 가격표 |
| `prompt.ts` | 전사 프롬프트(`TRANSCRIBE_PROMPT`)와 스캔 페이지용 변형(`SCAN_PROMPT`), 청크 이어붙이기 힌트 |
| `make-samples.ts` | 샘플 PDF 생성 — 표가 빽빽한 4쪽, 텍스트 레이어가 아예 없는 "스캔형" 3쪽 |
| `pdf-probe.ts` | P0-2·4 — pdfjs 동작 확인, 페이지별 문자 수, `height` 히스토그램 |
| `token-counts.ts` | P0-1 — 샘플 × `detail` × 모델 × (전체 / 1쪽) 입력 토큰 |
| `token-scaling.ts` | 1·2·3·5·10·19쪽으로 잘라 low / high / detail 생략 비교 |
| `token-per-page.ts` | 한 쪽씩 잘라 low·high — "어떤 쪽이 이미지로 렌더되는가"를 분리 |
| `page-images.ts` | pdfjs `getOperatorList`로 쪽별 이미지 XObject·벡터 path 수 (API 호출 없음) |
| `convert.ts` | P0-1·2 — 실제 Responses API 변환. 케이스별 실행 |
| `fidelity-detail.ts` | fidelity가 1.0이 아닐 때 **무엇이** 빠졌는지 (누락 구간 출력) |
| `web-convert.ts` | P0-3 — fetch → Readability → rehype-remark 파이프라인과 보존율 계측 |
| `out/` | 변환 결과 markdown과 `metrics.jsonl` (사람이 판단하는 자료) |

생성한 PDF·슬라이스 등 임시물은 저장소가 아니라 스크래치패드
(`SPIKE_SCRATCH`, 기본값은 이 세션의 스크래치 디렉터리)에 둡니다.

## 실행

```bash
# 1회: 샘플 PDF 생성 (스크래치패드에)
npx tsx scripts/spike-import/make-samples.ts

# pdfjs 동작 + height 분포 (API 호출 없음)
npx tsx scripts/spike-import/pdf-probe.ts
SPIKE_OPS=1 npx tsx scripts/spike-import/page-images.ts

# 토큰 측정 — 전부 무료
npx tsx scripts/spike-import/token-counts.ts
npx tsx scripts/spike-import/token-scaling.ts
npx tsx scripts/spike-import/token-per-page.ts

# 실제 변환 — 과금됩니다. 케이스 목록을 먼저 보세요
npx tsx scripts/spike-import/convert.ts --list
npx tsx scripts/spike-import/convert.ts spec-p1-5-low-flex
npx tsx scripts/spike-import/convert.ts all          # 7건 전부, 약 $0.056

# fidelity 손실의 내역
npx tsx scripts/spike-import/fidelity-detail.ts

# 웹 변환 (LLM 없음)
npx tsx scripts/spike-import/web-convert.ts
npx tsx scripts/spike-import/web-convert.ts https://example.org/some/page
```

`OPENAI_API_KEY`는 저장소 루트 `.env`에서 dotenv로 읽습니다. 출력 어디에도 키를
찍지 않습니다.

## 환경 메모

- Node 22.14, CommonJS 저장소. 스크립트는 `npx tsx`로 돌립니다.
  `unified`/`rehype-*`/`remark-*`/`@mozilla/readability`는 ESM이라 전부 동적 `import()`.
- `pdfjs-dist`는 legacy build(`pdfjs-dist/legacy/build/pdf.mjs`)를 쓰고,
  `useSystemFonts: true` · `disableFontFace: true` · `isEvalSupported: false`로 canvas 없이
  텍스트만 읽습니다. 경고 0건.
- openai 4.104에는 `client.responses.inputTokens`가 없습니다.
  `client.post('/responses/input_tokens', { body: { model, input } })`로 직접 호출하고
  `input_tokens`를 읽습니다.
- `input_file` content part의 `detail`은 SDK 타입에 없지만 API는 받습니다(캐스팅 필요).
  `service_tier: 'flex'`도 그대로 동작하고 응답이 `service_tier: "flex"`로 되돌려줍니다.

## 샘플

| 샘플 | 출처 | 왜 |
| --- | --- | --- |
| `shared-mime-info-spec.pdf` (19쪽) | `/usr/share/doc/shared-mime-info/` | 텍스트형 장문. 헤딩 계층·표·코드 블록·그림이 섞여 있음 |
| `table-heavy.pdf` (4쪽) | `make-samples.ts` 생성 | 표 8개 80행 + 머리말·쪽번호 (프롬프트가 지우라고 한 것들) |
| `image-only.pdf` (3쪽) | `make-samples.ts` 생성, `/usr/share/info/gnupg-module-overview.png` 삽입 | 텍스트 레이어가 전혀 없는 "스캔" 대역 |
| `matplotlib.pdf` (1쪽) | matplotlib 패키지 | 텍스트도 래스터 이미지도 없는 순수 벡터 도형 |

한글 폰트가 설치돼 있지 않아 **한국어 텍스트형 PDF는 만들지 못했습니다.** 계획서의
"텍스트형 한국어 규정" 샘플은 실물이 생기면 같은 `convert.ts` 케이스로 추가하세요
(토큰은 영어보다 문자당 1.5~2배로 잡는 편이 안전합니다).
