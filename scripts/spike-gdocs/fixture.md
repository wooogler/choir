# CHOIR 복제본 변환 테스트

이 문서는 GitHub → Google Docs 단방향 복제 시 **HTML import 변환 품질**을 실측하기 위한 픽스처입니다.

## 1. 텍스트 서식

**굵게**, *기울임*, ~~취소선~~, 그리고 `인라인 코드` 입니다.
링크도 확인합니다: [CHOIR 저장소](https://github.com/wooogler/choir).

### 1.1 3단계 헤딩

헤딩이 Docs 개요(outline)에 Heading 1/2/3으로 잡히는지가 핵심 확인 항목입니다.

## 2. 목록

- 최상위 항목
- 중첩이 있는 항목
  - 2단계 항목
    - 3단계 항목
- 마지막 항목

1. 순서 있는 첫째
2. 순서 있는 둘째
   1. 중첩된 순서 항목

## 3. 표

| 항목 | GitHub | Google Docs |
| --- | --- | --- |
| 원본 여부 | source of truth | 복제본 |
| 편집 | 허용 | 반영 안 됨 |
| 라인 blame | `git blame` | 불가 |

## 4. 코드 블록

```typescript
export async function publishToGoogleDocs(workspaceId: string, files: MarkdownFile[]) {
  for (const file of files) {
    const html = renderMarkdownToDocsHtml(file.content, { title: file.name });
    await drive.files.update({ fileId: mapFileId(file.path), media: { mimeType: 'text/html', body: html } });
  }
}
```

들여쓰기와 줄바꿈이 보존되는지 확인합니다.

## 5. 인용문

> 복제본은 파생물이므로 전체 내용 교체가 정확한 의미론입니다.
> 사람이 편집하지 않는다는 전제가 깨지면 이 설계는 무너집니다.

---

## 6. 이미지

원격 URL 이미지를 Drive가 실제로 가져와 임베드하는지 확인합니다.

![구글 로고](https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png)

## 7. 마지막 섹션

변환이 문서 끝까지 도달했는지 확인하는 표식입니다. **END-OF-FIXTURE-MARKER**
