# Google Docs 서식 보존 동기화 — 진단과 권고안

원본 서식이 살아 있는 Google Doc(예: Makeability Lab Handbook)을 CHOIR로 가져오고,
CHOIR에서 갱신한 내용이 **그 원본 문서에** 반영되게 하되, **문서의 서식을 파괴하지 않는**
방법에 대한 설계 판단.

기존 계획 문서 [`docs/google-drive-sync.md`](google-drive-sync.md)의 확정 사항 중
**"Docs 전용 서식의 보존은 non-goal"** 과 **"복제본은 파생물이므로 전체 내용 교체가 정확한
의미론"** 두 가지를 뒤집는 제안이다. 나머지 확정 사항(GitHub source of truth, 관리자 승인,
`drive.file` 단일 스코프, 문서별 mutex, baseline 3-way merge)은 전부 유지된다.

조사 방법: 서로 다른 각도의 설계안 5건을 독립 작성 → 각 설계에 적대적 비판 2건(총 10건)
→ Google 공식 문서로 API 사실 8건 독립 검증 → 관점이 다른 심사 3명이 채점. 아래는 그 결론이다.

---

## 0. 먼저 할 일 (코드와 무관, 시간 민감)

이미 평탄화된 Handbook 원본은 **API로 복구할 수 없다.** CHOIR의 덮어쓰기는 그 문서에
평범한 편집으로 기록되어 있으므로, Google Docs UI에서 **파일 → 버전 기록 → CHOIR가 처음
쓰기 전 버전으로 복원**하면 되돌아온다. 단 Docs의 리비전은 시간이 지나면 자동으로 병합·정리되므로
(계획 문서에서 이미 인용한 공식 명시 사항) **먼저 복원해 두는 편이 안전하다.**

복원한 뒤에는 그 문서를 다시 import하지 말고, 아래 Phase A가 들어갈 때까지 링크를 끊어 두는 것이
좋다. 현재 코드에서는 GitHub 쪽이 바뀌는 순간 같은 덮어쓰기가 다시 일어난다.

---

## 1. 진단 — 어디서 서식이 사라지는가

파괴적 원시 연산은 **딱 하나**다.

[`drive-client.ts:127`](../services/google/drive-client.ts#L127)의 `replaceDocContent`가
`files.update`를 `media: text/markdown`으로 호출한다. Google 공식 문서상 변환을 동반한 update는
**문서의 전체 내용을 교체**한다(검증 완료, §4). 즉 폰트·정렬·페이지 설정·로고 크기가 아니라
"markdown을 Docs가 렌더한 결과"로 문서가 다시 그려진다.

이 연산에 닿는 경로는 여섯 곳이며, 전부 `publishReplica`를 거친다.

| 경로 | 위치 |
|---|---|
| import 직후 링크 | [`import-service.ts:149`](../services/google/import-service.ts#L149) `publishReplica({force:true})` |
| Picker로 기존 문서 링크 | [`routes.ts:302`](../services/google/routes.ts#L302) |
| rebaseline | [`routes.ts:559`](../services/google/routes.ts#L559) |
| Slack 문서 업데이트 | [`document-updater.ts:231`](../services/github/document-updater.ts#L231) |
| 웹 에디터 저장 | [`save-document.ts:129`](../services/docs-editor/save-document.ts#L129) |
| 승인/거절 | [`review-service.ts`](../services/google/review-service.ts) 두 곳 |

스크린샷의 증상은 전부 여기서 설명된다. 배너는 [`banner.ts`](../services/google/banner.ts)의
`withBanner`가 본문 첫 줄로 삽입한 것이고, Arial 11·좌측 정렬·로고 축소는 markdown → Docs 변환의
기본 렌더링이다. **import 자체는 무해하다. 그 직후의 "링크" 단계가 원본을 덮어쓴다.**

부수적으로, CHOIR 자체 코드에도 이 문제를 키우는 지점이 하나 있다.
[`document-updater.ts:123`](../services/github/document-updater.ts#L123)은 노드 하나를 고친 뒤
`treeToMarkdown`으로 **파일 전체를 다시 직렬화**한다. 그리고
[`markdown-tree.ts`](../services/document/markdown-tree.ts)의 직렬화기에는 `table` 케이스가 없다
(`root`부터 `thematicBreak`까지 있으나 표는 없다). 그래서 Slack에서 한 문단만 고쳐도 markdown의
많은 줄이 바뀌고, 표는 망가진다. 이걸 고치지 않으면 아래 어떤 설계를 써도 "건드린 문단만
바뀐다"는 약속이 첫 업데이트에서 깨진다.

---

## 2. 권고 아키텍처 — 통째로 교체하지 말고, 바뀐 문단만 고친다

설계안 5개가 서로 다른 각도에서 출발했는데 **전부 같은 방향으로 수렴했다.** 원본 Doc을 링크된
문서로 계속 유지하고, `files.update` 대신 **Google Docs API의 `documents.batchUpdate`로 바뀐
문단만** 손대는 것이다. 심사 3명(사용자 결과 / 엔지니어링 리스크 / 유지보수)이 모두 같은 설계를
1위로 뽑았다.

핵심은 정렬 순서다. **먼저 저장소 markdown 공간에서 무엇이 바뀌었는지 구하고, 그 다음에만 Doc을
들여다본다.** 그래서 아무도 편집하지 않은 문단은 요청이 아예 생성되지 않고, 결과적으로 로고
문단·조판용 빈 문단·조판 폰트 제목·가운데 정렬 서명줄은 **인덱스가 언급되지조차 않아** 그대로
남는다.

### 2.1 세 방향의 흐름

**Import (Docs → 저장소, 새 문서).** 지금과 같이 `files.export`로 markdown을 받아 커밋하고
미러에 쓴다. 달라지는 것은 마지막 단계다. `publishReplica({force:true})`를 **호출하지 않고**,
쓰기 없이 상태만 심는다.

- baseline := 방금 받은 export 원문
- source snapshot := 커밋한 markdown (`extractImportable`의 결과)
- 상태 := `synced`, `lastPushedContentHash` := 그 markdown의 해시

`extractImportable`은 이미지 라벨만 다시 키잉할 뿐 줄 구조를 바꾸지 않으므로, 이 쌍은
`alignBaselineToSource`의 LCS 정렬이 요구하는 성질을 그대로 만족한다. **Doc에는 아무것도 쓰지
않는다.** 배너도, 리비전 한 줄도 남기지 않는다. 링크 사실은 Drive 파일의 `description`
메타데이터에 적는다(본문이 아니므로 export에 나타나지 않고, 배너 훼손·복원 로직 전체가 이
경로에서 사라진다).

**GitHub → Doc.** 훅 세 곳과 승인/거절은 지금 그대로 `publishReplica`를 부른다. 그 안에서
매핑의 모드가 보존 모드면 `pushWithVersionFence` 대신 패치 경로로 분기한다.

1. 쓰기 전 진실 검사: `files.export` → 저장된 baseline과 비교. 다르면 사람이 편집한 것이므로
   쓰지 않고 `drifted`로 넘긴다. **승인·거절의 force 경로에도 반드시 적용한다**(§3의 결함 3).
2. 저장소 공간에서 hunk 계산: 현재 Doc의 export를 `extractImportable`에 통과시킨 S와, 보내려는
   target markdown을 정규화 키로 diff한다.
3. `documents.get`으로 Doc 구조를 읽어 `revisionId`와 문단별 인덱스를 얻는다.
4. hunk마다 요청을 컴파일한다. 문단 교체는 종료 개행을 남긴 채 내용만 비우고 다시 채워
   문단 스타일(정렬·간격·목록·명명 스타일)을 유지하고, 폰트·크기·색은 **추론에 기대지 말고
   원래 첫 run의 스타일을 명시적으로 재적용한다**(§4의 검증 결과 때문에 중요하다).
5. `writeControl.requiredRevisionId`를 걸고 `batchUpdate`. 배치는 원자적이라 하나라도 잘못되면
   아무것도 적용되지 않는다.
6. 성공하면 지금과 똑같이 export → baseline, source snapshot, 상태를 기록한다.

**적용할 수 없는 변경은 추측하지 않고 거부한다.** 표 구조 변경, 코드 블록, 도형·수식·각주,
위치 고정 개체, 다중 탭, 열린 제안(suggestion)이 걸린 문단은 요청을 만들지 않고 관리자에게
"직접 반영해 달라"는 카드를 보낸다. 실패 방향이 **원본 훼손이 아니라 "Doc이 GitHub보다 뒤처짐"**
이 되도록 만드는 것이 이 설계의 핵심 가치다.

**Doc → GitHub.** **손대지 않는다.** 폴러, export-vs-baseline 진실 검사, `gdocs-delta`의 3-way
merge, Slack 리뷰 카드, 웹 리뷰 화면, `reviewedVersion`/`oursBlobSha` CAS 펜스가 전부 그대로
동작한다. baseline이 "CHOIR가 마지막으로 쓴 직후의 export"라는 성질이 유지되기 때문이다.
달라진 건 그 쓰기가 전체 교체가 아니라 패치(또는 import·승인 시에는 무-쓰기)라는 점뿐이다.

### 2.2 데이터 모델 — 모드 플래그는 하나, 위치가 중요하다

새 상태값은 만들지 않는다. 추가되는 영속 필드는 **모드 플래그 하나**뿐이고, 그것은
[`GoogleDocMapping`](../services/workspace/workspace-store.ts#L29)에 둔다.
`GdocsDocState`에 두면 안 된다. 링크 라우트는 [`routes.ts:293`](../services/google/routes.ts#L293)에서
매핑을 만든 직후 `publishReplica`를 부르는데 그 시점의 상태는 `null`이므로, 상태에 얹은 플래그는
**정확히 필요한 순간에 읽히지 않아 새로 링크하는 문서마다 파괴적 경로로 떨어진다.** 게다가
`gdocs-sync.json`은 버전 관리되지 않는 `data/` 아래 평문 JSON이고 읽기 실패를 빈 파일로 흡수하므로
(과거 디스크 사고 이력이 있다), 상태 손실이 곧 원본 덮어쓰기가 된다. 매핑은 암호화된 워크스페이스
설정에 있고 복호화 실패 시 예외를 던진다.

기본값은 추론하지 않는다. `createDocFromMarkdown`은 **프로덕션 호출자가 없고**
(`scripts/dev/`의 시드·페이크뿐), 지금 존재하는 매핑은 전부 Picker로 만들어진 것이다. 따라서
"Picker면 보존"이라는 규칙을 쓰면 배포 즉시 기존 replica 전부가 새 컴파일러로 넘어간다.
배포 시 일회성 백필로 기존 매핑을 전부 `replica`로 찍고, 이후 모드가 없는 매핑은 기본값을 쓰지 말고
**오류로 처리**한다. 세터의 필수 인자로 만들어 세 군데 쓰기 지점 모두에서 명시적 결정을 강제한다.

### 2.3 문단 쓰기 원시 연산 — 스타일은 두고 텍스트만 바꾼다

Docs에서 서식은 두 층에 붙어 있다. **문단 스타일**(정렬·간격·명명 스타일·글머리표)은 문단의
종료 개행 문자가 지니고, **run 스타일**(폰트·크기·색·굵게·기울임·링크)은 문자 구간이 지닌다.
그래서 "텍스트만 바꾼다"는 것은 정확히 다음 두 규칙으로 환원된다. **종료 개행은 절대 지우지
않는다**(문단 스타일이 살아남는다), 그리고 **바뀌지 않은 문자 구간은 건드리지 않는다**(그 구간의
run 스타일이 살아남는다). 컴파일러는 세 단계 중 가장 세밀한 것부터 시도한다.

**1단계 — 스팬 교체 (기본).** 옛 문단 텍스트와 새 텍스트의 공통 접두·접미를 구해, 그 사이의
차이 구간만 교체한다. 새 텍스트를 옛 구간 **바로 뒤에** `insertText`로 넣고(삽입 텍스트는 직전
문자의 스타일을 물려받으므로, 옛 구간 끝 문자의 스타일을 받는다), 옛 구간을
`deleteContentRange`로 지운다. 삽입이 삭제 범위 뒤에 있어 인덱스가 서로 영향을 주지 않으므로
한 배치에 담는다. 접두·접미 안의 run은 요청이 닿지 않으니 그대로다. 즉 문단 중간의 기울임
단어, 하이퍼링크, "Make"만 굵은 제목의 나머지 부분이 **전부 살아남는다.** 이것이 "기존 스타일을
써서 텍스트만 바꾸기"의 가장 강한 형태다.

**2단계 — 비우고 다시 채우기 (차이 구간이 문단의 대부분일 때).** 새 텍스트를 종료 개행 **직전**에
삽입해 문단 자신의 마지막 run 스타일을 물려받게 한 뒤, 옛 텍스트 범위를 지운다. 문단 스타일은
개행이 남아 유지되고, 폰트·크기·색은 상속으로 따라온다. 문단 안에 섞여 있던 두 번째 폰트나
색은 이 단계에서 사라진다(§7).

**3단계 — 명시적 재적용 (안전망).** Google 문서는 삽입 텍스트의 스타일 상속을 "일반적으로",
"대부분의 경우"라고만 약속한다(§4). 그래서 2단계 뒤에는 원래 첫 run의 폰트·크기·색을
`updateTextStyle`로 명시적으로 다시 건다. 상속이 실제로 어떻게 동작하는지는 스파이크 체크
7a·7b·7c가 세 순서를 각각 측정한다. 특히 7c(지우고 나서 문단 시작에 삽입)는 삽입 텍스트가
**앞 문단**의 스타일을 물려받는 누수를 잡아내는 용도다. 그 결과가 컴파일러가 1·2단계 중
무엇을 기본으로 삼을지, 3단계가 필수인지를 결정한다.

새 텍스트에 markdown 인라인 마크(굵게·기울임·링크·취소선·코드)가 있으면 해당 부분 구간에만
`updateTextStyle`을 건다. 상속받은 문자가 링크를 갖고 있는데 새 텍스트의 markdown에는 링크가
없으면 그 마크만 해제한다. 굵게·기울임은 해제하지 않는다. 굵은 헤딩 run에서 물려받은 굵기는
의도된 것이기 때문이다.

`replaceAllText`는 쓰지 않는다. 문서 전체를 부분 문자열로 매칭하므로 같은 문장이 두 군데 있으면
둘 다 바뀌고, 탭을 지정하지 않으면 모든 탭에 적용되며, 문단 단위 교체라 스팬 교체가 살리는
인라인 run을 살리지 못한다.

---

## 3. 반드시 함께 고쳐야 할 결함 4가지

비판 단계에서 **설계 4개에 독립적으로 반복 등장한** 것들이다. 아키텍처 문제가 아니라 국소 버그지만,
고치지 않으면 조용한 데이터 손실이 된다.

**결함 1 — 거부된 쓰기에 콘텐츠 해시를 기록하는 것.** 지금의 raced-into-drift 분기는
[`replica-publisher.ts:103`](../services/google/replica-publisher.ts#L103)에서
`lastPushedContentHash`를 쓴다. 오늘은 옳다. 그 시점엔 `files.update`가 **이미 성공했고** 못 믿을 건
baseline뿐이기 때문이다. 그러나 `requiredRevisionId` 불일치 400은 **아무것도 쓰이지 않았다**는
뜻이다. 그런데 해시가 기록되면, 사람이 편집을 되돌렸을 때 폴러가 `metadata-only`로 판정해 `synced`로
돌리고([`drift-detector.ts:137`](../services/google/drift-detector.ts#L137) 이하), 다음 publish는
[`replica-publisher.ts:84`](../services/google/replica-publisher.ts#L84)의 해시 가드에 걸려
`unchanged`를 반환한다. **GitHub 변경이 아무 흔적 없이 사라진다.** Google은 리비전 ID가 내부 요인으로도
바뀔 수 있다고 명시하므로 사람 없이도 발생한다.
→ 실제로 적용된 쓰기만 해시를 기록한다. 거부·부분 실패는 별도 결과값으로 분리한다.

**결함 2 — 문단 경계 밖 삽입.** 새 문단을 앞 블록의 종료 인덱스에 삽입하면, 그 자리는 다음 구조
요소의 시작이다. Google 문서상 텍스트는 **기존 문단 경계 안에** 삽입해야 하고 표의 시작 인덱스에는
넣을 수 없다. 문서 끝에 섹션을 덧붙이는 것은 Slack 업데이트의 가장 흔한 형태인데, 그대로 두면
배치 전체가 400으로 거부된다.
→ 앵커 문단의 종료 개행 **직전**에 개행을 포함해 삽입한다.

**결함 3 — 승인·거절 경로의 열린 창.** `reviewedVersion` 펜스는 락 안에서 확인되고, 락을 놓고
커밋이 돌고, 그 다음에야 Doc 쓰기가 일어난다. 그 사이에 사람이 친 문단은 "저장소에 없는 블록"으로
보여 삭제 대상이 된다. 펜스가 막으려던 바로 그 손실이다.
→ 리뷰 렌더 시점의 Docs `revisionId`를 함께 저장해 쓰기의 `requiredRevisionId`로 쓰고, 쓰기 직전에
export를 한 번 더 비교한다.

**결함 4 — 거부가 집계되지 않는 것.** 대량 드리프트 차단기는
[`drift-detector.ts:262`](../services/google/drift-detector.ts#L262)에서 `normalizationOnly`인
`DriftResult`만 센다. 패치 거부는 `PublishResult`라 sweep에 도달하지 못한다. Google이 export
직렬화를 바꾸면 **모든 보존 문서가 조용히 정지**하고 아무도 통보받지 못한다.
→ sweep 결과에 거부 카운터를 넣고 임계치를 넘으면 관리자 카드 대신 운영자 경보로 대체한다.

---

## 4. 검증된 Google API 사실

공식 문서를 직접 인용해 확인한 것만 적는다.

| 사실 | 판정 | 근거 |
|---|---|---|
| `documents.get` / `documents.batchUpdate`가 `drive.file` 스코프를 받음 | **확인** | 두 메서드 레퍼런스가 `drive.file`을 인가 스코프로 명시. Docs 인증 페이지는 이를 "Recommended / Non-sensitive"로 분류 |
| Picker per-file grant가 Docs API에도 미치는가 | **문서 조합으로만 성립** | Docs 인증 페이지의 "앱이 사용하는 특정 파일" 정의 + Drive 스코프 페이지의 "Picker로 사용자가 공유한 파일". 반증 문구도 없음. **명시 문장은 없으므로 실측 필요** |
| `batchUpdate`가 필요한 요청 타입을 모두 지원 | **확인** | InsertText / DeleteContentRange / ReplaceAllText / UpdateParagraphStyle / UpdateTextStyle / CreateNamedRange / InsertInlineImage / InsertTable 전부 Request union에 존재 |
| 삽입 텍스트의 스타일 상속 | **확인, 단 보장 아님** | "자동으로 결정", "일반적으로", "대부분의 경우 삽입 지점 **앞** 텍스트와 일치". 개행으로 만들어진 문단은 목록·글머리표까지 복사됨 |
| `files.update`(변환)가 전체 내용을 교체 | **확인** | 업로드 가이드가 "문서의 전체 내용을 교체"로 명시 |
| 그때 머리글·바닥글·페이지 설정이 어떻게 되는지 | **문서 없음** | Google이 어디에도 기술하지 않음. "전체 내용"이 유일한 표현 |
| DOCX/HTML export의 서식 충실도 | **문서 없음** | Google은 변환 충실도에 대해 아무 진술도 하지 않음. export 상한 10 MB는 확인 |
| 제안(suggestion) 모드 쓰기 | **가능하나 Developer Preview** | `WriteControl.writeMode=SUGGEST`. 일반 배포에는 쓸 수 없음 |
| API로 만든 앵커 댓글 | **Docs UI에서 앵커로 보이지 않음** | 가이드가 "Workspace 편집기 앱은 이를 앵커 없는 댓글로 취급"이라고 명시 |
| 다중 탭 | **읽기는 확인, export는 문서 없음** | `includeTabsContent`·`tabId`는 문서화됨. `files.export`의 탭 처리에 대한 공식 진술은 없음 |
| Docs API 쿼터 | **확인** | 사용자당 분당 읽기 300 / 쓰기 60 |

### 실측이 필요한 것 (Phase B 착수 전 게이트)

스크립트는 [`scripts/spike-gdocs/docs-spike.ts`](../scripts/spike-gdocs/docs-spike.ts)에 준비되어
있다(실행 방법은 스파이크 README의 "P0-C 검증"). **실제 Handbook**에 대고 돌린다. 합성
픽스처에는 도형도, 커스텀 폰트도, 소프트 줄바꿈도 없어서 아무것도 증명하지 못한다. 스파이크는
지정한 문서를 `files.copy`로 복사한 뒤 **사본에만** 쓰므로 원본은 안전하다. 실행 전에 GCP
콘솔에서 **Google Docs API를 켜야** 한다.

1. refresh token만 가진 서버가, Picker로 받은(앱이 만들지 않은) 문서에 `documents.get`과
   무해한 `batchUpdate`를 할 수 있는가. **이 하나가 실패하면 설계 전체가 성립하지 않는다.**
   그때는 민감 스코프(`documents`)로 가지 말고 Phase A에서 멈추는 편이 낫다. 심사가 만장일치로
   같은 판단을 했다. CASA·제한 스코프 심사는 서식 이득보다 훨씬 큰 영구 비용이다.
2. 도형과 로고가 있는 상태에서 markdown export가 연속 3회 바이트 동일한가. 지금까지의 측정은
   CHOIR가 markdown으로 만든 문서에 대해서만 이루어졌다.
3. `batchUpdate`가 Drive의 `version`을 올리는가. 폴러의 트리거가 이 값에 의존한다.
4. 문단 내용을 비우고 다시 채웠을 때 문단 스타일(정렬·간격·명명 스타일)이 유지되는가.
5. 가운데 정렬 서명줄이 소프트 줄바꿈(U+000B)을 쓴 **한 문단**인지, 세 문단인지. export 줄과
   Doc 블록의 대응이 여기서 갈린다.

---

## 5. 구현 계획

실행 세션이 이 절만 읽고 진행할 수 있도록 쓴다. 각 항목은 실제 파일과 줄에 앵커를 걸었고, 계획
시점(2026-09-02)의 트리 기준이다. 순서대로 진행하되 **Phase A는 Docs API 없이 완결되는 단위**이고,
**Phase B는 P0-C 스파이크 결과가 있어야 시작**한다.

### Phase 0 — 지금 (반나절, 코드 없음)

1. Google Docs UI에서 Handbook을 CHOIR가 처음 쓰기 전 버전으로 복원한다. 복원한 문서는 Phase A가
   배포될 때까지 링크하지 않는다.
2. GCP 콘솔에서 **Google Docs API**를 켠다(Drive API와 같은 프로젝트).
3. `pnpm spike:gdocs` 후 [`docs-spike.ts`](../scripts/spike-gdocs/docs-spike.ts)를 **복원한
   Handbook**에 대고 돌린다. 사본에만 쓰므로 안전하다. 결과를 스파이크 README의 "P0-C 검증"
   아래에 기록한다. 체크 1(관문)과 체크 4(export 결정성)가 Phase B의 go/no-go다. 체크 7a·7b·7c는
   §2.3의 어느 단계가 기본이 되는지를 정한다.

### Phase A — 파괴 중단 (5~7일, Docs API 불필요)

> **구현 상태 (2026-09-02). Phase A 완료.** A1~A7이 전부 들어갔다. `pnpm verify` 통과,
> 신규 테스트 41건(총 499건). 구현하면서 계획과 달라진 것이 두 가지 있다.
>
> **A5의 발송 지점은 publish 훅이 아니라 폴러다.** 세 훅 중 어느 것도 Slack 클라이언트를 갖고
> 있지 않다 — `schedulePublish`는 Slack에 닿을 방법이 없는 서비스에서 fire-and-forget으로
> 불린다. 그래서 `recordPendingManual`은 상태만 남기고, 폴러가 매 sweep마다
> `documentsAwaitingNotice`로 아직 아무도 통보받지 못한 문서를 찾아 카드를 보낸다. 대량 드리프트
> 억제와는 무관하므로 그 게이트 앞에 둔다.
>
> **A6에서 remark-gfm은 넣지 않았다. 계획이 틀렸다.** 실측 결과 (a) 표는 지금 깨지지 않는다 —
> gfm 없이는 표가 `paragraph`로 파싱되고 인라인 평탄화가 원문 파이프 줄을 그대로 되돌려
> 바이트 동일하게 왕복한다. (b) remark-gfm은 `node_modules`에서 **해석되지 않는다**. pnpm 스토어에
> web의 전이 의존성으로만 있어서 `pnpm add`가 필요하다. (c) 표 케이스만 추가하면 **순손실**이다.
> 맨 URL이 `[url](url)`로 재작성되고, 체크박스가 사라지며, 각주 참조가 조용히 삭제된다. 그리고
> 접합이 들어간 뒤로는 `treeToMarkdown`이 Slack 업데이트 경로에서 아예 빠지므로 표를 위해
> gfm을 넣을 동기 자체가 대부분 사라진다. 실제 손상은 표가 아니라 순서 목록, 중첩 목록,
> frontmatter, 들여쓰기 코드 블록, 그리고 끝 개행이었고 접합이 그 전부를 해결한다.
> `treeToMarkdown`은 `normalize-markdown-files-action`과 새 섹션 추가 경로에 여전히 남아 있으므로,
> gfm은 그 경로들을 근거로 따로 판단해야 하는 **독립적인 변경**이다.

원칙: **보존 모드 문서에는 본문 쓰기가 한 번도 일어나지 않는다.** CHOIR → Doc 반영은 관리자가
직접 하고, CHOIR는 무엇을 반영할지 정확히 알려준다.

**A1. 매핑에 모드 플래그.**
- [`workspace-store.ts:29`](../services/workspace/workspace-store.ts#L29) `GoogleDocMapping`에
  `mode: 'replica' | 'preserve'` 추가. 읽기 타입에서는 선택(legacy `undefined`를 표현·감지하기
  위해), [`setGoogleDocMapping`](../services/workspace/workspace-store.ts#L1026)의 인자에서는
  **필수**. 쓰기 지점 세 곳([`routes.ts:293`](../services/google/routes.ts#L293),
  [`import-service.ts:142`](../services/google/import-service.ts#L142), 이후 추가될 곳)이
  컴파일 타임에 결정을 강제받는다.
- 백필 스크립트 `scripts/backfill-gdocs-mode.ts`(`backfill:dashboard` 패턴): 모드가 없는 기존
  매핑 전부에 `replica`를 찍는다. 배포 순서는 **백필 → 재시작**.
- [`publishReplica`](../services/google/replica-publisher.ts#L61)는 매핑을 읽은 직후(:67)
  `mode`가 없으면 `{outcome:'failed', detail:'unknown-mode'}`로 **닫고**, 상태 `error`에 기록한다.
  기본값을 추론하지 않는다(§2.2).
- 테스트: `__tests__/google-workspace-auth.test.ts`에 세터 필수 인자, `google-replica-publisher.test.ts`에
  unknown-mode 실패.

**A2. Import는 쓰지 않는다.**
- [`import-service.ts:149-154`](../services/google/import-service.ts#L149)의 `publishReplica({force:true})`를
  제거하고, `replica-publisher.ts`에 새로 두는 `seedReplica`를 호출한다.
  ```ts
  seedReplica({ workspaceId, githubPath, markdown, exportedAtRead }): Promise<SeedResult>
  ```
  `replicaLock.run(docKey(...))` 안에서: (1) `setDocDescription`(A2의 새 drive-client 함수,
  메타데이터 전용 `files.update`, `fields:'id,version'`)으로 링크 사실을 적는다. 본문이 아니라
  export에 안 나온다. version이 한 번 오르므로 **다음 단계의 읽기보다 먼저** 한다. (2) export를
  다시 받고 `getDocMeta`. (3) `writeBaseline(exportedAtRead)`, `writeSourceSnapshot(markdown)`.
  baseline은 항상 **커밋을 만들어 낸 바로 그 export**다 — 이 쌍이 `alignBaselineToSource`가
  요구하는 대응이다. (4) 두 export가 같으면 `synced` + `lastPushedVersion` +
  `lastPushedContentHash: contentHash(markdown)`(github-sync sweep이 같은 내용을 다시 밀지
  않도록). 다르면 사람이 그 사이에 쳤다: 상태 `drifted`, `latestVersion`만 기록, **해시는
  기록**(내용은 실제로 Doc에 있었으므로 옳다). baseline이 올바르므로 다음 sweep이 그 편집을
  정상 드리프트로 리뷰에 올린다.
- 모드는 `preserve`. [`import-steps.ts`](../services/google/import-steps.ts)의 `linking` 라벨을
  "Linking the Google Doc (nothing is written to it)"로.
- 새 `documents.get` 사전 점검은 Phase B(Docs 클라이언트가 없다). Phase A에서는 다중 탭 문서를
  거를 수 없으므로 README와 UI에 "탭이 여럿인 문서는 첫 탭만 동기화됨"을 명시한다.
- 테스트: [`gdocs-import.test.ts`](../__tests__/gdocs-import.test.ts)에 `replaceDocContent`가
  **호출되지 않음**, baseline/source 쌍 기록, synced+해시, 두 번째 export가 다를 때 drifted.

**A3. 보존 모드에서 `replaceDocContent`는 도달 불가.**
- `publishReplica`: 매핑 읽기 직후 `mode === 'preserve'`면 `pushWithVersionFence`로 절대 내려가지
  않고 `holdForManual`(A5)로 분기. 가드는 힘(`force`)과 무관하다.
- 호출 지점 여섯 곳의 의미를 보존 모드별로 정한다.
  | 호출 | 위치 | 보존 모드 동작 (Phase A) |
  |---|---|---|
  | 훅 3곳 | document-updater:231 / save-document:129 / github-sync:70 | `holdForManual` — 카드 발송 |
  | 링크 라우트 | [`routes.ts:256-320`](../services/google/routes.ts#L256) | **`replica` 모드 유지**(기존 CHOIR 문서를 Docs로 내보내는 용도, 경고 유지). 기존 GitHub 문서를 서식 있는 기존 Doc에 `preserve`로 링크하는 것은 컴파일러가 있어야 하므로 Phase B |
  | rebaseline | [`routes.ts:530-566`](../services/google/routes.ts#L530) | 무-쓰기 재시드: baseline := export, source := `extractImportable(export).markdown`, **해시는 기록하지 않음**(미러와 Doc이 갈라져 있을 수 있고, 다음 GitHub 변경이 카드를 만들어야 한다) |
  | 배너 복원 | [`drift-detector.ts:197-210`](../services/google/drift-detector.ts#L197) | 보존 모드는 배너가 없으므로 건너뜀 |
  | 승인 | [`review-service.ts:277`](../services/google/review-service.ts#L277) | 커밋 후 재시드(baseline := export, source := `extractImportable(export).markdown`). 관리자가 리뷰 화면에서 손본 부분과 보류됐던 GitHub 변경은 Doc에 없으므로 `diff(source, params.content)`를 카드로 발송. `committed-not-republished` 루프에 빠지지 않도록 승인 경로는 `publishReplica`가 아니라 재시드를 직접 호출 |
  | 거절 | [`review-service.ts:404`](../services/google/review-service.ts#L404) | Doc을 되돌릴 수단이 없다. 재시드 + 카드 "편집이 Doc에 남아 있습니다. 버전 기록으로 직접 되돌리세요." **제품 결정 필요**(§7) |
- 테스트: 보존 모드 publish가 어떤 인자로도 `replaceDocContent`를 호출하지 않음(`mockReplace`
  미호출 단언), 승인·거절이 재시드로 끝남.

**A4. 재시드에 진실 검사.** 모든 재시드는 export를 두 번 받아 같아야 기록한다
([`pushWithVersionFence`](../services/google/replica-publisher.ts#L177)의 settle 로직에서 쓰기만
뺀 형태로 추출해 공유). 승인·거절은 기존 `reviewedVersion` 펜스가 그대로 적용된다.

**A5. 수동 반영 카드.**
- 새 `services/google/manual-apply-notifier.ts`. [`drift-notifier.ts`](../services/google/drift-notifier.ts)의
  `recipientsFor`·카드 북키핑 패턴을 따르되(가능하면 `recipientsFor`를 공용으로 추출), 카드 내용은
  파일명 + 통합 diff(`diffIndices(sourceAtPush, target)` 기반, 2,000자에서 자름) + Doc 딥링크 +
  버튼 두 개. 카드 참조는 `GdocsDocState.manualCards`에 **`reviewCards`와 분리해** 저장한다.
  drift-notifier의 `chat.update` 갱신이 덮어쓰면 안 되기 때문이다.
- 상태 필드 추가([`types.ts`](../services/google/types.ts#L41)): `pendingManual?: { targetHash: string;
  declined?: boolean }`, `manualCards?: GdocsReviewCard[]`. **새 `GdocsDocStatus` 값은 없다.**
  `pendingManual`은 HOLDING_STATES가 아니다 — 더 새로운 GitHub 변경은 대상을 교체하고 카드를
  갱신한다.
- 리스너: `listeners/features/google-docs/`(index.ts 등록, CLAUDE.md의 피처 폴더 규칙) 에
  `gdocs_manual_applied` / `gdocs_manual_declined` 액션. **적용 완료**: 락 안에서 export →
  `extractImportable(export).markdown`을 `alignmentKey`로 대상과 비교 → 같으면 재시드(baseline :=
  export, source := target, 해시 := `contentHash(target)`, synced) + 카드 은퇴. 다르면 "아직 Doc이
  대상과 다릅니다"로 갱신하고 유지. **그대로 두기**: `pendingManual.declined = true`, 카드 은퇴.
  같은 해시는 다시 카드를 만들지 않는다.
- 자동 정착: [`checkAndHealDocument`](../services/google/drift-detector.ts#L197)에서만 — 결과가
  `drifted`이고 `pendingManual`이 있으면 `extractDelta`를 돌려 `conflicts.length === 0 &&
  newAssets.length === 0 && merged === target`일 때 재시드 + 카드 은퇴. **`checkDocumentForDrift`
  안에서는 절대 부르지 않는다.** 같은 문서 락을 이미 쥐고 있고 mutex는 재진입이 안 된다
  (코드 주석 [`drift-detector.ts:195`](../services/google/drift-detector.ts#L195)).
- 테스트: `google-drift-detector.test.ts`에 자동 정착의 세 조건, 새 `google-manual-apply.test.ts`에
  적용 완료/그대로 두기/불일치 유지.

**A6. CHOIR 쪽 선행 수정 (Google과 무관).**
- [`document-updater.ts:96-123`](../services/github/document-updater.ts#L96): 비앵커 경로가 노드
  하나를 바꾼 뒤 `treeToMarkdown`으로 **파일 전체를 재직렬화**한다(:123). 앵커 경로(:52-80)는 이미
  `applyAnchorReplacement`로 원문에 접합한다. 비앵커 경로도 같은 방식으로: 교체된 노드의
  `position.start.offset`/`position.end.offset`(remark-parse가 붙이는 mdast 위치)을 써서
  `originalFileContent`에 새 노드의 markdown만 접합한다. 같은 파일에 업데이트가 여럿이면 오프셋
  내림차순으로 적용. `replaceNodeWithEnhancedContent`
  ([`main-service.ts:164`](../services/file-registry/main-service.ts#L164))가 교체 노드를 돌려주도록
  반환값을 넓힌다.
- 표: [`markdown-tree.ts:91-93`](../services/document/markdown-tree.ts#L91)의 파서가 `remark-parse`만
  쓴다. `remark-gfm`(이미 `node_modules`에 있음)을 `.use`에 추가해 표가 `table` 노드로 파싱되게 하고,
  [`treeToMarkdown`](../services/document/markdown-tree.ts#L275)에 `table`/`tableRow`/`tableCell`
  케이스를 넣는다. 파서 변경은 색인·검색에도 영향이 있으므로 **기존 markdown 테스트 전체가
  녹색인지** 확인한다.
- 테스트: 노드 하나 업데이트 후 나머지 줄이 **바이트 동일**함을 단언하는 테스트, 표 왕복 테스트.

**A7. UI·문서.**
- [`GoogleDocsImport.tsx`](../web/src/components/GoogleDocsImport.tsx): "덮어쓴다"는 문구가 있으면
  제거, 다중 탭 안내 추가. [`GoogleDocsSync.tsx:22`](../web/src/components/GoogleDocsSync.tsx#L22)의
  `REPLACE_WARNING`은 `replica` 링크에만 남긴다. 상태 배지에 `preserve`와 "수동 반영 대기" 표시.
- [`docs/google-drive-sync.md`](google-drive-sync.md): non-goal 행과 "전체 교체" 행에 이 문서로의
  포인터.

**Phase A 완료 기준.** 서식 있는 Doc을 import했을 때 Doc의 리비전 기록에 CHOIR의 쓰기가 **한 건도
없고**, Slack에서 그 문서를 업데이트하면 관리자에게 diff 카드가 오며, Doc에서 사람이 고친 것은
기존 리뷰 경로로 GitHub에 들어온다. `pnpm verify` 녹색.

### Phase B — 패치 컴파일러 (18~25일, 스파이크 통과 후)

**B0. 게이트.** 스파이크 체크 1·4 PASS가 README에 기록되어 있어야 한다. 체크 1이 실패하면
**여기서 멈춘다.** 민감 스코프로 가지 않는다.

**B1. 백업.** 보존 문서에 대한 **첫 쓰기 직전**에 `files.copy`로 앱 폴더(`createFolder` 재사용)에
사본을 만들고 매핑에 `backupFileId`/`backedUpAt`을 기록한다. 언링크
([`routes.ts:414`](../services/google/routes.ts#L414))에서 사본을 지운다. 매핑당 하나. 복원은
자동화하지 않고 뷰어에 사본 링크를 보여 준다. 동일 충실도 복원은 이것뿐이다.

**B2. Docs 클라이언트.** `@googleapis/docs` 의존성 추가. 새 `services/google/docs-client.ts`:
`getDocument(auth, fileId, {includeTabsContent, fields})`, `batchUpdate(auth, fileId, requests,
requiredRevisionId)`. [`drive-client.ts`](../services/google/drive-client.ts#L50)의 `withRetry`를
공유하되 429 백오프 상한을 늘린다(Docs 쓰기 쿼터는 사용자당 분당 60). 400 중 revision 불일치를
`RevisionMismatchError`로 구분한다. **이 모듈만 Google을 안다** — 나머지는 전부 순수 함수다.

**B3. 문서 구조.** `services/google/doc-structure.ts`: 스파이크의 `flatten`을 옮긴다. 블록 배열
(문단/표 행/섹션 나눔/목차), 각 블록의 인덱스·평문·`charStyles`·문단 스타일·첫 run 스타일·인라인
개체·특수 요소·소프트 줄바꿈·글머리표. 인덱스는 UTF-16 코드 유닛이라 JS 문자열 길이와 일치한다.
탭이 여럿이면 `unsupported`. 열린 제안이 있으면 `held`.

**B4. 줄 키.** `services/google/line-keys.ts`: 대상 markdown을 `marked.lexer` 블록 토큰으로 자른다
(**줄이 아니라 블록** — 하드랩 산문, 표 구분 행, 여러 줄 인용문이 한 블록이 되도록). 각 블록의
`plainKey`(헤딩 마크·목록 마커·인용 마커·인라인 마크 제거, `[t](u)`→t, 언이스케이프, 공백 축약,
따옴표·nbsp 정규화)와 인라인 스팬 목록. `gdocs-delta.ts`의 `ESCAPED_PUNCTUATION`을 export해
공유한다.

**B5. 컴파일러.** `services/google/patch-compiler.ts`:
1. 정렬: 대상 블록 키와 Doc 블록 키를 `node-diff3`의 `LCS`로 맞춘다([`alignBaselineToSource`](../services/google/gdocs-delta.ts#L252)와
   같은 도구). 맞은 쌍은 **요청 없음**. 이미지 문단은 인라인 개체의 alt/description으로 키를 만들어
   `![alt](…)`와 맞춘다. 빈 문단·섹션 나눔·위치 고정 개체의 앵커 문단·목차는 **삭제 가능 집합에서
   제외**한다(로고와 조판용 빈 문단을 지우는 사고를 막는다).
2. 맞지 않은 구간을 위치로 짝지어 연산으로: `replaceSpan`(§2.3 1단계) → 차이가 문단의 60%를 넘으면
   `refill`(2단계 + 3단계) / `insertAfter`(앵커 문단의 `endIndex - 1`에 개행 포함 삽입, 문단 스타일은
   앵커 것을 **전부** 복사하고 헤딩이면 `namedStyleType`만 교체, 글머리표는
   `createParagraphBullets`) / `deleteParagraph`(개행 포함, 마지막 문단이면 앞 문단의 개행 쪽을 지움).
3. 거부 집합: 표 구조 변경, 코드 펜스, 도형·수식·각주·칩·페이지 나눔이 있는 문단, 위치 고정 개체
   앵커. 거부 hunk는 A5의 카드로 간다. 거부는 배치 전체를 막지 않는다 — 적용 가능한 hunk는
   적용하고 거부만 보고한다.
4. 안전장치: 블록이 10개를 넘는데 50% 미만이 맞으면 전체 거부(`patch-unmappable`). 모든 계산된
   범위의 실제 텍스트가 기대와 같은지 **요청을 내보내기 전에** 검증한다.
5. 요청은 인덱스 **내림차순**으로 내보낸다.

**B6. 배관.** `publishReplica`의 보존 분기가 `holdForManual` 대신 `patchWithRevisionFence`를 부른다:
진실 검사(export === baseline, force에도 적용) → `getDocument` → 컴파일 → 요청이 비어 있으면 재시드만
→ `batchUpdate(requiredRevisionId)` → settle export → baseline/source/state 기록. **거부·부분·400에는
`lastPushedContentHash`를 절대 기록하지 않는다**(§3 결함 1). revision 불일치는 새 결과값
`revision-conflict`: 상태와 해시를 건드리지 않고 다음 트리거가 재시도한다.

**B7. 승인·거절.** [`buildReview`](../services/google/review-service.ts#L137)가 `reviewedVersion`
옆에 Docs `revisionId`를 저장하고, 승인·거절의 패치가 그것을 `requiredRevisionId`로 쓴다(§3 결함 3).
거절의 비교는 `plainKey`가 아니라 **export 원문**으로 한다 — 링크 대상만 바꾼 편집도 되돌려야
한다.

**B8. 집계.** [`SweepResult`](../services/google/drift-detector.ts#L220)에 `patchRefused` 카운터를
넣고, publish 결과가 sweep에 도달하도록 `publishLinkedReplicas`의 결과를 합산한다. 임계치
(`MASS_DRIFT_THRESHOLD`와 동일)를 넘으면 관리자 카드 대신 운영자 경보(§3 결함 4).

**B9. 개발 루프.** [`scripts/dev/fake-drive.ts`](../scripts/dev/fake-drive.ts) 옆에
`fake-docs.ts`: 인메모리 Document JSON에 `insertText`/`deleteContentRange`/`updateTextStyle`/
`updateParagraphStyle`을 적용하는 가짜 `batchUpdate`. 스파이크가 저장한 실제 Handbook의
`documents.get` 응답을 `__tests__/fixtures/`에 넣는다. B3~B5는 이 픽스처로 **자격 증명 없이**
테스트한다.

**B10. 마이그레이션.** 기존 `replica` 문서를 `preserve`로 바꾸는 라우트(`rebaseline`에 `mode`
인자): 첫 문단이 배너면 펜스 건 `batchUpdate`로 삭제 → 현재 미러 markdown으로 **패치 publish**
(보류됐던 커밋이 이때 반영된다; 무-쓰기 재시드가 아니다) → 모드 변경. 링크 라우트도 `preserve`
옵션을 얻는다: 기존 GitHub 문서를 기존 Doc에 걸면 첫 패치가 둘을 맞추되 50% 가드에 걸리면
`import`/`replace` 중 고르게 한다.

**Phase B 완료 기준.** 복원한 Handbook을 import하고 Slack에서 본문 한 문단을 고쳤을 때, Doc에서
그 문단의 텍스트만 바뀌고 로고·제목 폰트·서명줄 정렬·나머지 문단이 바이트 단위로 그대로다.
표가 있는 섹션을 고치면 관리자 카드가 오고 Doc은 손상되지 않는다. 진행 중에 사람이 Doc을 치면
`revision-conflict`로 물러나고 GitHub 변경은 유실되지 않는다.

### Phase C — 선택

제안 모드(`writeMode: SUGGEST`)가 Developer Preview를 벗어나면 B6의 `batchUpdate`에 필드 하나를
추가해 CHOIR 변경을 **Docs 제안**으로 넣는 옵션. 지금 준비할 것은 없다.

---

## 6. 기각된 대안

| 대안 | 기각 사유 |
|---|---|
| **DOCX 왕복** (export → OOXML 패치 → 재import) | 핵심 가정인 "Docs→DOCX→Docs가 고정점"이 검증 불가능하다. Google은 변환 충실도를 아무 데도 문서화하지 않고, 실측 하나는 반대를 가리킨다(export가 모든 run을 Arial Unicode MS로 바꾸고 7.6 KB를 223 KB로 부풀림, export 상한은 10 MB). 게다가 매 push가 여전히 전체 교체라 댓글·제안·도형이 매번 사라진다. **백업 수단으로만 채택** |
| **소유권 역전** (Doc이 진실의 원천, GitHub은 파생) | Doc 먼저 쓰고 나중에 커밋하는 순서가 "복제 발행은 커밋을 지연시키거나 실패시키면 안 된다"는 기존 계약을 뒤집는다. 커밋 실패가 로그로만 삼켜지는 경로가 이미 있어, Doc만 앞서고 폴러는 영원히 조용한 상태가 만들어진다 |
| **Docs 탭 분리** (원본은 탭1, 복제는 탭2) | 사람은 탭1을 읽고 편집하므로 CHOIR가 동기화하는 탭에는 드리프트가 영영 발생하지 않는다. `files.export`의 탭 처리도 문서화되어 있지 않다 |
| **동반 복제 문서** | 사람이 여전히 원본을 편집하므로 두 어려운 방향이 하나도 해결되지 않는다 |
| **Apps Script** | `script.projects` 스코프와 문서별 배포가 필요해 `drive.file` 모델에서 크게 벗어난다 |
| **named range 앵커** | rebaseline마다 쓰기가 늘어 펜스가 복잡해지고, 사람이 문단을 지우면 무너진다. 매 쓰기 직전의 `documents.get`이 더 정확한 인덱스를 준다 |
| **섹션(heading) 단위 연산** | 너무 거칠다. 한 문장 업데이트가 섹션 전체의 정렬·폰트를 날린다 |

---

## 7. 남은 리스크와 열린 질문

- **Picker grant가 Docs API에 미치는지가 단일 실패점이다.** 문서 조합으로는 성립하지만 명시
  문장이 없다. 스파이크 1번이 실패하면 Phase A에서 멈춘다.
- **풍부한 서식 문서의 export 결정성은 미측정이다.** 도형·위치 고정 개체·커스텀 폰트가 있는
  문서의 export가 흔들리면 진실 검사 전체가 매 sweep마다 오탐을 낸다.
- **CHOIR가 다시 쓰는 문단 안의 서식은 여전히 잃는다.** 문단 중간에서 시작하는 두 번째 폰트·색·
  하이라이트, 수동 줄바꿈은 첫 run의 스타일로 수렴한다. 제목의 "Make"만 굵은 조판은
  그 줄을 CHOIR가 편집할 때만 문제가 되며, 실제로 편집할 일은 드물다.
- **표·코드 블록·이미지·도형이 걸린 변경은 자동 반영되지 않는다.** 거부 후 사람이 반영한다.
  관리자가 카드를 무시하면 Doc과 GitHub이 계속 벌어진다. 상태 배지 외의 에스컬레이션은 없다.
- **거절의 의미론을 정해야 한다.** 보존 모드에서 거절이 사람의 문단을 되돌리면 그가 준 서식도
  함께 사라진다. 되돌리지 않으면 폴러가 계속 드리프트로 잡는다. 제품 결정이 필요하다.
- **`plainKey` 비교의 사각지대.** 링크 대상만 바꾸거나 강조만 바꾼 편집은 정규화 키에서 같게
  보인다. 거절 판정은 정규화 키가 아니라 export 원문으로 비교해야 한다.
- **다중 탭 문서는 v1에서 링크를 거부한다.**
- **쿼터.** 보존 문서가 20개를 넘는 워크스페이스에서 전체 sweep이 분당 60 쓰기에 닿을 수 있다.
  Drive 래퍼보다 긴 백오프가 필요하다.
