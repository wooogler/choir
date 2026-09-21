# 회의록 만들기(Meeting note)와 용어집

> 상태: **R1·G1·G2·M1·M2 구현 완료 (2026-09-21)** — 웹 대화상자(`MeetingNoteDialog`, `GlossaryBuilderDialog`)와 용어집 companion 커밋 포함. 미착수: App Home의 회의록 폴더·용어집 파일명 설정(기본값 사용), M3의 `.docx` 외 확장, P3 항목. 아래 "구현 현황" 참고.

## 구현 현황 (2026-09-21)

- **이름 변경(R1)**: `services/docs-editor/rename-document.ts` + `rename-route.ts`(`/documents/rename/check`, `/documents/rename`). 한 커밋에 새 경로·이동한 사이드카 추가와 옛 경로 삭제; 미러·경로 맵·벡터 스토어(새 GitHub URL)·Google Doc 매핑/상태/baseline·읽기 전용 항목 재기록; 열린 리뷰가 있으면 `rename_review_pending`. `inboundLinks`는 링크하는 **문서 수**. 뷰어 `RenameDocumentDialog`는 헤더의 삭제 옆.
- **파일명 추천**: `web/src/utils/file-names.ts`의 `suggestFileNameFromSiblings`. New document·Rename·회의록 만들기가 공유. 빈 제목은 폴더 접두를 유지하고 단어 부분만 fallback.
- **용어집(G1)**: `services/glossary/{parse,load,prompt-block,table}.ts`. 스캔 PDF 전사 프롬프트와 견적에 동일하게 주입. 미러 mtime+size 캐시.
- **용어집 만들기(G2)**: `extract.ts`(Responses API json_schema, 12k 토큰 청크, 기존 항목 제외, 150개 상한), `commit.ts`, `routes.ts`(`GET /glossary`, `POST /glossary/extract`, `POST /glossary/commit`). 씨앗 문서는 기존 import draft(PDF·URL)다. `services/glossary/index.ts`는 `commit`을 재export하지 않는다(octokit 유입 방지).
- **회의록 만들기(M1 서버)**: `services/import/sources/text/`(vtt/srt/transcript-text/docx/plain 감지·파싱; 60% 규칙은 줄 수가 아니라 **커버리지**로 잰다), `services/import/sources/meeting/`(meta 검증, 템플릿, 청크·리듀스 프롬프트, 변환, 견적). 라우트 `POST /import/meeting`(업로드+견적) → `POST /import/meeting/:id/convert`(NDJSON) → 기존 `/import/commit`. 충실도는 화자 이름을 포함한 원문과 비교한다(그렇지 않으면 정상 회의록도 0.8 아래로 떨어졌다).
- **M2**: `saveEditedDocument`/`createDocument`의 `companionEdits`(같은 커밋, 사이드카 없음, 벡터 스토어 갱신)와 `POST /import/commit`의 `glossary` 필드(`services/import/glossary-companion.ts`). 미리보기의 "용어집에 추가할까요?" 카드가 체크한 항목을 보낸다.
- **웹**: `MeetingNoteDialog.tsx`(파일/붙여넣기, 회의 정보, 프로젝트 멤버 기본 참석자, 견적 → 변환 → 미리보기), `GlossaryBuilderDialog.tsx`(PDF·URL 씨앗 → 후보 표 편집 → 가장 가까운 용어집/새 파일), 프로젝트 설정의 용어집 탭에서 상태·빌더 진입.
- 계획과 다른 점: `PEOPLE.md` 없음(프로젝트 멤버로 대체), `IMPORT_PDF_*` 설정을 회의록도 그대로 쓴다(`IMPORT_LLM_*`로 일반화하지 않음), App Home 설정 없음(기본 `meetings/`, `GLOSSARY.md`). `docs/pdf-web-import.md`의 import 파이프라인(draft → 미리보기 → `createDocument`)을 재사용하되, 사용자에게는 "import"가 아니라 **"회의록 만들기"** 라는 하나의 기능으로 보인다.

## 왜

회의 transcript(Zoom·Teams·Clova Note 등)를 저장소 문서로 남기고 싶다. 그런데 transcript는 그대로 넣으면 가치가 낮다.

1. **받아쓰기 오류.** 고유명사·프로젝트명·전문용어가 소리 나는 대로 적힌다("코이어", "콰이어" → CHOIR). 오기가 인덱스에 들어가면 그 용어로 질문해도 못 찾는다.
2. **구조 없음.** 한 시간짜리 대화는 참고 문서가 아니다. 결정·할 일·논의 요지가 뽑혀 있어야 Q&A가 인용한다.
3. **맥락 없음.** 파일 이름만으로는 어느 회의인지, 누가 있었는지 모른다. 이건 LLM이 아니라 **만드는 사람이 한 줄씩 알려주는 게** 가장 정확하다.

그래서 이 기능은 "파일을 올리면 변환"이 아니라 **"회의 정보를 입력하고 transcript를 붙이면 회의록이 나온다"** 는 모양이다. 용어집은 1번을 풀기 위한 전제이자, 2·3번에도 쓰인다.

## 사용자 흐름

뷰어 사이드바에 **"회의록 만들기"** (New document, Import… 와 나란히). 관리자 + push 권한.

### 1단계 — 회의 정보 대화상자 (`MeetingNoteDialog`)

| 입력 | 기본값 | 쓰이는 곳 |
| --- | --- | --- |
| transcript 파일 (`.vtt` `.srt` `.txt` `.docx` `.md`) 또는 텍스트 붙여넣기 | — | 본문 |
| 제목 | 파일명에서 추정 (`weekly-sync`) | `# ` 제목, 파일명 |
| 날짜 | 파일명·큐의 날짜 → 없으면 오늘 | 메타 블록, 파일명 |
| 폴더 | 현재 열린 문서의 프로젝트가 있으면 그 프로젝트의 `meetingsFolder`(기본 `<프로젝트>/meetings/`), 없으면 App Home의 회의록 폴더 설정(기본 `meetings/`) | 저장 경로 |
| 파일명 | **같은 폴더의 다른 파일 이름을 본떠 placeholder로 추천**(아래). 제목을 따라가다 직접 고치면 멈춤 (NewDocumentDialog와 같은 규칙) | 저장 경로 |
| 참석자 | 폴더의 **프로젝트에 연결된 Slack 채널 멤버**가 미리 채워짐(`docs/project-folders.md`; 아래 3b). 그 외 사람은 최근 회의록의 참석자에서 자동완성 | 메타 블록, 화자 이름 정규화, 익명화 매핑 |
| 한 줄 맥락 (선택) | — | 프롬프트 ("이 회의는 X 프로젝트 주간 회의") |
| 형식 | **회의록** / 정리된 transcript | 변환 모드 |

**파일명 추천 — 폴더의 관례를 따른다.** 폴더마다 이름 규칙이 있다(`2026-09-13-weekly-sync.md`, `01-onboarding.md`, `Weekly_Sync_0913.md`). 새 파일은 그 관례를 따라야 목록에서 제자리에 놓인다. 순수 함수 `suggestFileNameFromSiblings(siblings, { date, title }) → { placeholder, pattern, examples }`:

- 형제 파일명에서 지배적 패턴을 고른다: 날짜 접두(`YYYY-MM-DD`, `YYYYMMDD`, `YYYY.MM.DD`) / 번호 접두(`01-`, `1_`) / 접두 없음, 구분자(`-` vs `_`), 대소문자, 한글 유지 여부. 과반이 없으면 기본값 `{날짜}-{슬러그}.md`.
- 날짜 접두면 오늘(또는 입력한 날짜)로, 번호 접두면 최대값+1로, 나머지는 제목 슬러그로 채운다.
- 입력창에는 **placeholder(회색)** 로 보이고, 비워 두고 저장하면 그 값이 쓰인다. 아래에 "이 폴더의 파일: 2026-09-13-weekly-sync.md, 2026-09-06-weekly-sync.md …" 세 개를 예시로 보여준다.
- `NewDocumentDialog`도 같은 함수를 쓴다(지금은 제목 슬러그만).

여기서 바로 견적(토큰·비용)을 보여주고 "만들기"를 누르면 변환한다. transcript가 아닌 일반 텍스트(신호 없음)를 올려도 막지 않는다 — 형식이 "회의록"이면 LLM이 있는 내용으로 채우고, 없는 절(결정 사항 등)은 "없음"으로 둔다.

### 2단계 — 미리보기 (기존 `ImportPreviewDialog` 재사용)

CrepeEditor에서 편집, 경고(교정된 용어 수, 화자 미상 발화 비율), **"용어집에 추가할까요?"** 카드(아래 용어집 5번), 저장. 경로는 1단계에서 정했으니 여기서는 확인만.

### 산출물 — 회의록 형식

```markdown
# 주간 동기화 회의

> 출처: 2026-09-20-weekly.vtt (58분, 2026-09-20 가져옴) <!-- choir:source -->

| 날짜 | 참석자 | 관련 |
| --- | --- | --- |
| 2026-09-20 | 이상욱, 김민지, 박준호 | CHOIR 주간 회의 |

## 요약
(5줄 이내)

## 결정 사항
- …

## 할 일
| 할 일 | 담당 | 기한 |
| --- | --- | --- |

## 논의
### (주제별 소제목)
…

## 전체 기록
**이상욱**: …
```

- 메타 표는 사용자가 입력한 값 그대로다. LLM이 채우지 않는다.
- "정리된 transcript" 형식은 메타 표 + `## 전체 기록`만 있는 같은 문서다. 나중에 회의록으로 바꾸고 싶으면 다시 만들면 된다.
- 요약·결정·할 일·논의는 LLM이 쓰되, **전체 기록은 전사 원칙**(내용을 빼거나 요약하지 않음, 타임스탬프·군말 제거, 용어 교정, 화자 이름은 참석자 목록의 표기로 통일)을 따른다.

## 용어집

### 1. 저장소 폴더 안의 마크다운 파일이다

별도 UI·DB가 아니라 **문서 폴더 안의 `GLOSSARY.md`**. 이유: CHOIR의 모든 지식은 GitHub 마크다운이라는 원칙과 맞고, 버전이 남고, 뷰어에서 편집·리뷰되고, **이미 인덱싱되어** "X가 뭐야?"에 답한다. 사람이 읽는 문서이면서 기계가 읽는 데이터다.

### 2. 폴더 단위로 유지된다

용어집은 어느 폴더에나 둘 수 있고, 문서를 만들 때 **그 문서의 폴더에서 루트까지 올라가며 만나는 `GLOSSARY.md`를 전부 합친다**(가까운 것이 우선). 그래서:

- 저장소 루트의 `GLOSSARY.md` = 조직 공통 용어.
- `meetings/GLOSSARY.md` 또는 `projects/alpha/GLOSSARY.md` = 그 폴더(팀·프로젝트)만의 용어와 사람.
- 새 용어 추가는 **가장 가까운 용어집**에 들어간다. 없으면 회의록 폴더에 `GLOSSARY.md`를 새로 만들 것을 제안한다(같은 커밋).

파일명은 App Home에서 바꿀 수 있다(기본 `GLOSSARY.md`). 대소문자 무시.

### 3. 형식

표 하나. 파서는 너그럽다 — 헤더 이름은 무시하고 3열 이상인 표의 첫 3열을 `용어 | 다른 표기 | 설명`으로 읽는다. `## 시스템` / `## 연구 용어` 같은 절로 나눠도 된다. 사람은 여기 넣지 않는다 — 프로젝트의 Slack 채널 멤버가 그 역할이다(아래 3b).

```markdown
# 용어집

| 용어 | 다른 표기 | 설명 |
| --- | --- | --- |
| CHOIR | 코이어, 콰이어, choir | 이 프로젝트. Slack 지식 봇 |
| QMD | 큐엠디 | 로컬 검색 인덱스 (`@tobilu/qmd`) |
| RAG | 래그, 랙 | Retrieval-Augmented Generation. 검색 결과를 붙여 답을 생성하는 방식 |
```

`다른 표기`가 **받아쓰기 오류와 별칭**의 자리다. transcript 교정의 핵심 입력.

### 3a. 용어집이 없을 때 — 문서에서 만들어 시작한다

빈 표부터 채우라고 하면 아무도 안 만든다. 용어집이 없는 폴더에서 회의록을 만들면(또는 사이드바의 **"용어집 만들기"** 를 직접 누르면) 이렇게 제안한다:

1. "이 폴더에 용어집이 없습니다. `meetings/GLOSSARY.md`를 만들까요?" — 위치는 회의록 폴더가 기본, 루트로 바꿀 수 있다.
2. **씨앗 문서를 받는다.** 논문 PDF, 발표 자료 PDF, 기존 텍스트·마크다운 파일, 또는 URL — 이미 있는 import 소스가 markdown으로 바꿔 준다(PDF는 `convertPdf`, 텍스트는 `sources/text`, URL은 `convertUrl`). 여러 개를 한 번에 올릴 수 있다.
3. LLM이 markdown에서 **용어 후보**를 뽑는다: 약어와 그 풀이(`RAG → Retrieval-Augmented Generation`), 고유명사(시스템·데이터셋·모델·프로젝트 이름), 본문이 정의하는 개념어. 각 항목에 한 줄 설명. `다른 표기`는 비워 두되, 약어의 풀이·영문/한글 표기 쌍처럼 문서에서 확실한 것만 채운다 — 받아쓰기 오기는 문서로는 알 수 없으니 회의록을 만들면서 5번의 고리로 쌓인다.
4. **미리보기는 편집 가능한 표**(CrepeEditor 그대로). 관리자가 줄을 지우고 고쳐서 저장하면 `GLOSSARY.md` 커밋. 이미 용어집이 있는 폴더에서는 같은 흐름이 "이 문서에서 용어를 뽑아 추가"가 되어 새 행만 미리보기에 나온다(중복은 기존 항목과 대조해 제외).
5. 씨앗 문서 자체는 저장소에 넣지 않는다. 넣고 싶으면 별도로 import한다(그쪽은 그쪽 미리보기가 있다).

비용은 씨앗 문서를 markdown으로 바꾸는 값(PDF는 PDF import와 같음)에 용어 추출 한 번(문서 토큰 + 출력 1~2k)이 더해지는 정도다.

### 3b. 참석자는 프로젝트의 Slack 채널 멤버에서 (2026-09-20 변경)

처음에는 `PEOPLE.md`를 용어집처럼 따로 두려 했으나, **그 사람들은 이미 Slack 채널에 있다**. 문서로 사본을 만들면 어긋난다. 그래서 `docs/project-folders.md`의 프로젝트 폴더가 이 역할을 맡는다:

- 회의록이 들어갈 폴더의 **프로젝트에 연결된 채널의 멤버**(봇 제외)가 참석자 기본값. 큰 채널이면 프로젝트 설정에서 "핵심 멤버만"으로 줄인다.
- 화자 라벨 매핑(`Speaker 1` → 사람)과 받아쓰기 교정용 **별칭**은 프로젝트 메타데이터 `members.aliases`에 Slack 사용자 ID를 키로 저장한다. 이름은 저장하지 않고 실시간으로 붙인다.
- 익명화 매핑(`services/anonymization`)은 이 멤버·별칭 목록으로 채운다.
- 회의록에 입력한 참석자가 멤버가 아니면(외부 협업자) 그냥 이름 텍스트로 남는다. 카드는 없다.
- 프로젝트가 아닌 폴더의 회의록은 참석자 칸이 비어 있고 최근 회의록의 참석자만 자동완성된다. "이 폴더를 프로젝트로 만들면 채널 멤버가 채워집니다" 한 줄.

`PEOPLE.md`는 만들지 않는다.

### 4. 코드: `services/glossary/`

- `loadGlossary(workspaceId, forPath) → { entries: GlossaryEntry[], files: string[] }` — 폴더 체인을 올라가며 미러에서 읽고, 파일 mtime으로 캐시. `GlossaryEntry = { term, aliases, description, section?, file }`.
- 사람 목록은 여기 없다 — `services/projects/`의 `projectMembers(workspaceId, folder)`(채널 멤버 + `members.aliases`)를 쓴다.
- `glossaryPromptBlock(entries, { text, maxTokens })` — 프롬프트용 압축 표현(`CHOIR (코이어, 콰이어): 이 프로젝트`). 상한(기본 1.5k 토큰) 초과 시 **본문에 별칭이 등장하는 항목**을 우선 고른다(문자열 매칭, 무료). 사람도 같은 함수로 블록을 만든다.
- `appendTableRows(markdown, rows)` — 표 끝에 행 추가(순수 함수). 용어집의 새 파일 템플릿도 여기.
- `extractGlossaryCandidates({ workspaceId, markdown, existing }) → GlossaryEntry[]` — 씨앗 문서에서 용어 후보 추출(3a). 기존 항목과 대조해 중복 제외.

### 5. 스스로 자라게

변환 프롬프트가 "목록에 없는 낯선 고유명사·약어는 그대로 두고 마지막에 `<unknown-terms>`로 나열하라"고 시키고, 미리보기 하단에 **"용어집에 추가할까요?"** 카드로 보인다. 관리자가 체크한 항목(설명은 한 줄 쓰거나 비워 둠)은 **회의록과 같은 커밋**에서 가장 가까운 `GLOSSARY.md`에 행으로 추가된다. 착지는 두 파일을 받아야 하므로 `createDocument`에 `companionEdits?: Array<{ path, content }>`(기존 파일 갱신) 옵션을 더한다 — 또는 `saveEditedDocument`를 이어서 한 번 더 부른다. 이 고리가 없으면 용어집은 한 번 만들고 잊히는 파일이 된다.

### 6. 다른 쓰임 (같은 모듈, 별도 단계)

- **PDF import**: 스캔 PDF의 OCR 오류 교정에 같은 블록을 넣는다(한 줄).
- **지식 추출**(`knowledge-extractor.ts`): Slack 대화에서 문서 갱신을 뽑을 때 표기를 통일한다. `organizationDescription`이 들어가는 자리에 함께 넣는다.
- **질의 확장**(`query-translation.ts`): 질문의 별칭을 정식 표기로 보강한다("코이어 설정" → CHOIR). 검색 정확도에 직접 효과.

## 변환 파이프라인 (`services/import/sources/text/`)

| 입력 | 감지 | 처리 |
| --- | --- | --- |
| `.vtt`, `.srt` | 확장자·큐 구조 | 큐 → 세그먼트 `{ speaker?, start?, text }` |
| transcript `.txt` | `HH:MM:SS`·`화자:` 패턴이 줄의 60% 이상 (Zoom, Teams, Clova Note, Otter) | 줄 → 세그먼트 |
| `.docx` | 확장자 | `mammoth` → HTML → 기존 `html-to-markdown` → transcript 감지 재시도 |
| `.txt`, `.md`, 붙여넣기 | 그 외 | 단락 그대로 세그먼트 하나 |

- 세그먼트를 약 6k 토큰 단위로 청킹(발화 경계). 모든 청크 프롬프트에 **용어집 블록 + 참석자 목록 + 한 줄 맥락**을 넣는다. 화자 라벨이 "Speaker 1"류면 참석자 목록에 맞춰 추정하되 확신이 없으면 그대로 둔다(경고에 비율 표시).
- 회의록 형식은 map-reduce: 청크별 `정리된 기록 + 요지` → 마지막 한 번의 호출로 요약·결정·할 일·논의를 합친다.
- **익명화**: 기존 `services/anonymization`(이름 → 자리표시자, 응답 후 복원)을 LLM 호출 앞뒤에 건다. 참석자 목록과 프로젝트 멤버 별칭(`members.aliases`)이 매핑에 별칭을 준다. 미리보기 토글 "화자 이름을 역할로 바꾸기"(이상욱 → 책임자) — 문서에 실명을 남길지는 관리자가 정한다.
- 모델·티어·`reasoning.effort: low`는 PDF 경로와 같다(`IMPORT_PDF_*` 설정을 `IMPORT_LLM_*`로 일반화, 기존 이름은 별칭 유지).
- 비용: 1시간 회의 ≈ 12~15k 토큰 입력, 출력 비슷 → gpt-5.4-mini flex 기준 **약 $0.05**. 견적은 1단계 대화상자에(파일이 텍스트라 로컬 토큰 추정으로 충분).

## 전제 기능: 문서 이름 변경·이동

확인 결과(2026-09-20) 뷰어·서버·GitHub 계층 어디에도 **이름 변경이 없다**. 만들기(`create-document.ts`)와 삭제(`delete-document.ts`)만 있다. 파일명을 추천받아 만든 문서를 나중에 고칠 수 없으면 추천이 부담이 되므로, 회의록 만들기보다 먼저 넣는다.

`services/docs-editor/rename-document.ts` — `renameDocument({ workspaceId, userId, from, to })`. 삭제와 같은 원칙(GitHub 커밋을 먼저, 로컬 상태는 그다음)으로, 경로를 키로 쓰는 모든 곳을 옮긴다:

| 대상 | 지금 키 | 이름 변경 시 |
| --- | --- | --- |
| 저장소 파일 | 경로 | 한 커밋에 `files: [{ to, content }]` + `deletions: [from]` (`commitFilesWithContext`는 둘 다 받는다). 메시지 `Rename from → to` |
| provenance 사이드카 | `.choir/context/<경로>/` | **같은 커밋에서** 디렉터리도 옮긴다. 안 옮기면 그 문서의 변경 이력이 뷰어에서 사라진다 |
| 미러 | 경로 | 파일·사이드카 디렉터리 이동 |
| 경로 맵(`PathMapService`, QMD 핸들 ↔ 경로) | 경로 | add-only라 삭제처럼 남은 목록으로 `save` 재실행 |
| 벡터 스토어 항목 | 경로 | 항목 교체(save-document의 갱신 블록 재사용), QMD warmup |
| Google Doc 매핑·상태·baseline (`gdocs-state`) | 경로 | 키 재기록. 리뷰 카드가 열려 있으면 삭제처럼 먼저 정리하거나 이동을 거부(제안: 거부 — "리뷰를 먼저 처리하세요") |
| 읽기 전용 목록 (`readOnlyFiles`, 파일명 기준) | 파일명 | 이름이 바뀌면 항목도 바꾼다 |
| 이미지 캡션 캐시 | 이미지 경로 기준 | 문서 경로와 무관 — 손대지 않음 |
| 다른 문서의 상대 링크 | — | **1차에서는 고치지 않는다.** 대신 미러를 grep해 "이 문서를 가리키는 링크 N개"를 대화상자에 경고로 보여준다. 자동 갱신은 후속 |

- 대상 경로 검증은 `normalizeDocumentPath`, 덮어쓰기 거부는 `createDocument`와 같은 exists 검사. 폴더 이동도 같은 함수다(`to`의 폴더가 다르면 이동).
- 라우트 `POST /api/docs/:ws/documents/rename` `{ from, to }`, 인증 사다리는 create/delete와 동일.
- UI: 문서 헤더의 삭제 옆에 "이름 변경" → `RenameDocumentDialog`(현재 경로, 새 경로 입력에 형제 파일명 추천 placeholder, 링크 경고). 성공 시 새 경로로 전체 로드.
- 예상 1일. 테스트: 커밋 파일 목록(추가+삭제+사이드카), 경로 키 재기록 각각, 열린 리뷰 카드 거부, 링크 경고 수.

## Non-goals

- 실시간 녹음·전사(STT). 파일을 받는다.
- 용어집 전용 편집 UI. 뷰어의 마크다운 편집기가 그 UI다.
- 화자 분리(diarization) 개선. 입력에 있는 화자 정보만 쓴다.
- Slack 허들 transcript 자동 수집. P3 후보.
- `.pptx`/`.rtf`/`.odt`. 필요해지면 Responses API `input_file`(텍스트 추출)로 PDF 경로에 얹는다.

## 단계

| 단계 | 내용 | 기간 |
| --- | --- | --- |
| R1 | 문서 이름 변경·이동(위 절) + 형제 파일명 기반 추천 함수(`NewDocumentDialog`에도 적용) | 1일 |
| G1 | `services/glossary/`(용어집의 폴더 체인 로딩·캐시·프롬프트 블록·행 추가) + App Home 설정(회의록 폴더, 용어집 파일명) + 스캔 PDF 프롬프트에 주입 + 테스트 | 1일 |
| G2 | "용어집 만들기": 씨앗 문서(PDF·텍스트·URL, 기존 소스 재사용) → 용어 후보 추출 → 편집 가능한 표 미리보기 → `GLOSSARY.md` 생성/추가. 없는 폴더에서의 생성 제안 | 1일 |
| M1 | `sources/text/` 파싱(vtt/srt/txt/붙여넣기), 청킹·익명화, "정리된 transcript" 형식, `MeetingNoteDialog`(회의 정보 폼 + 프로젝트 멤버 기본 참석자(PF1 필요) + 견적), 라우트 `POST /import/meeting`·`/import/meeting/:id/convert`, 미리보기 재사용 | 1.5일 |
| M2 | 회의록 형식(map-reduce), `<unknown-terms>` → 용어집 추가 카드 → 같은 커밋(`companionEdits`) | 1일 |
| M3 | `.docx`(mammoth), 용어집을 지식 추출·질의 확장에 주입 | 1일 |
| P3 | 화자 → 역할 치환, Slack 허들, `.pptx` | — |

## 결정된 것 / 열어둔 것

결정(2026-09-20):

- 기능 이름과 진입점은 **"회의록 만들기"**. import 메뉴의 한 항목이 아니라 자기 대화상자를 가진 독립 흐름.
- 폴더·파일명·참석자(·날짜·제목·한 줄 맥락)는 **사용자가 입력**한다. LLM이 추정하지 않는다.
- 용어집은 **저장소 폴더 안의 `GLOSSARY.md`**, 폴더 체인으로 합쳐 읽고 가장 가까운 것에 추가한다.
- 용어집이 없으면 **생성을 제안**하고, 논문 PDF·텍스트·URL 같은 **씨앗 문서에서 용어를 뽑아** 시작할 수 있게 한다(3a).
- "할 일" 담당자는 **이름 텍스트만**. Slack 멘션 ID는 GitHub 독자에게 무의미하다.
- 참석자 기본값은 **폴더의 프로젝트에 연결된 Slack 채널 멤버**다(3b, `docs/project-folders.md`). 처음 제안한 `PEOPLE.md`는 채널 멤버의 사본이 되므로 만들지 않는다.

열어둔 것:

1. 프로젝트가 아닌 폴더의 회의록 참석자를 어디서 채울지. 제안: 비워 두고 최근 회의록에서 자동완성, "프로젝트로 만들면 채널 멤버가 채워집니다" 안내.
2. 씨앗 문서를 여러 개 올릴 때 한 번에 추출할지 문서마다 카드로 나눌지. 제안: 합쳐서 한 표로, 각 행에 출처 문서명을 미리보기에서만 표시.
