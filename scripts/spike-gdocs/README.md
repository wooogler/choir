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
| `fixture.md` | 변환 위험 요소를 모아둔 테스트 픽스처 |
| `drive-spike.ts` | `drive.file` 스코프만으로 폴더 생성 / 문서 생성 / **내용 교체 시 fileId 유지** / 권한 설정 / 공유 드라이브를 검증. 기본은 마크다운 import, `--html`로 HTML 경로 |
| `markdown-to-docs-html.ts` | HTML import 경로용 렌더러 (`marked` 재사용). **측정 결과 마크다운 import가 우세해 기본 경로에서는 불필요** — 코드 블록 우선이면 사용 |
| `render.ts` | 위 렌더러로 마크다운 파일을 HTML로 렌더 |

## 실행

레포의 ts-node는 현재 이 스크립트를 직접 실행하지 못합니다(아래 "알려진 환경 문제"). 직접 컴파일합니다:

```bash
npx tsc --ignoreConfig scripts/spike-gdocs/markdown-to-docs-html.ts scripts/spike-gdocs/render.ts scripts/spike-gdocs/drive-spike.ts --outDir dist/spike-gdocs --rootDir scripts/spike-gdocs --module commonjs --target es2020 --esModuleInterop --skipLibCheck --types node
```

(`pnpm build`가 `rm -rf dist`를 하므로 빌드 후에는 위 컴파일을 다시 돌려야 합니다.)

렌더만:

```bash
node dist/spike-gdocs/render.js scripts/spike-gdocs/fixture.md dist/spike-gdocs/fixture.html
```

Drive 검증 (GCP 콘솔에서 "Desktop app" OAuth 클라이언트 JSON 필요):

```bash
GOOGLE_OAUTH_CLIENT=/path/to/client_secret.json node dist/spike-gdocs/drive-spike.js --keep
```

`--html`을 붙이면 마크다운 대신 HTML import 경로로 같은 검증을 돌립니다.

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

### 아직 미검증 (`drive-spike.ts`가 답할 항목)

MCP 커넥터는 넓은 스코프로 인증되고 내용 교체 API가 없어서 아래를 확인할 수 없었습니다:

- `drive.file` 스코프**만으로** 폴더 생성 / 문서 생성 / 권한 설정이 되는지
- **내용 교체 시 fileId와 URL이 유지되는지** — 설계 전체가 이 가정 위에 서 있습니다
- 공유 드라이브(shared drive)에서 위가 모두 되는지 — 조직 전체 공유가 목표라면 실질 관문

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
