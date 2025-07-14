# 실제 Slack에서 보이는 Diff 예시

## Slack Rich Text vs Markdown 차이점

### ❌ 일반 Markdown (제가 잘못 보여드린 것)
```
> ~~Old text~~ **New text**
```

### ✅ 실제 Slack Rich Text Block
Slack에서는 Rich Text Block Kit을 사용하여 다음과 같이 렌더링됩니다:

## 1. 간단한 텍스트 변경 예시

### 입력:
```
oldText: "Deploy using manual Docker commands"
newText: "Deploy using docker-compose setup"
```

### 실제 Slack에서 보이는 모습:
```
┌─────────────────────────────────────────┐
│ Deploy using manual Docker commands     │  ← 취소선 스타일 (회색 + 취소선)
│ docker-compose setup                    │  ← 굵은 글씨 스타일 (검은색 + 굵게)
└─────────────────────────────────────────┘
```

**시각적 특징:**
- 인용구(quote) 스타일의 좌측 회색 바
- 제거된 텍스트: 회색 + 취소선
- 추가된 텍스트: 검은색 + 굵은 글씨
- 변경되지 않은 텍스트: 일반 검은색

## 2. 복잡한 설정 변경 예시

### 입력:
```
oldText: "1. Install Docker\n2. Run: docker run -p 3000:3000 myapp"
newText: "1. Install Docker\n2. Create docker-compose.yml\n3. Run: docker-compose up"
```

### 실제 Slack에서 보이는 모습:
```
┌─────────────────────────────────────────┐
│ 1. Install Docker                       │  ← 일반 텍스트 (변경사항 없음)
│ 2. Run: docker run -p 3000:3000 myapp  │  ← 취소선 스타일 (제거됨)
│ 2. Create docker-compose.yml           │  ← 굵은 글씨 (추가됨)
│ 3. Run: docker-compose up              │  ← 굵은 글씨 (추가됨)
└─────────────────────────────────────────┘
```

## 3. 실제 Rich Text Block 구조

### JSON 구조:
```json
{
  "type": "rich_text",
  "elements": [
    {
      "type": "rich_text_quote",
      "elements": [
        {
          "type": "text",
          "text": "1. Install Docker\n2. ",
          "style": {}
        },
        {
          "type": "text", 
          "text": "Run: docker run -p 3000:3000 myapp",
          "style": {
            "strike": true
          }
        },
        {
          "type": "text",
          "text": "Create docker-compose.yml\n3. Run: docker-compose up",
          "style": {
            "bold": true
          }
        }
      ]
    }
  ]
}
```

### Slack 클라이언트에서 렌더링:
- `"style": { "strike": true }` → 회색 취소선 텍스트
- `"style": { "bold": true }` → 검은색 굵은 텍스트  
- `"style": {}` → 일반 검은색 텍스트
- `"type": "rich_text_quote"` → 좌측에 회색 세로 바

## 4. 인라인 볼드가 있는 경우

### 입력:
```
oldText: "Set *DEBUG=false* for production"
newText: "Set *DEBUG=true* for development"  
```

### Rich Text 구조:
```json
{
  "elements": [
    {
      "type": "rich_text_quote",
      "elements": [
        {
          "type": "text",
          "text": "Set ",
          "style": {}
        },
        {
          "type": "text",
          "text": "DEBUG=false",
          "style": {
            "bold": true,
            "strike": true
          }
        },
        {
          "type": "text", 
          "text": " for ",
          "style": {}
        },
        {
          "type": "text",
          "text": "production",
          "style": {
            "strike": true
          }
        },
        {
          "type": "text",
          "text": "DEBUG=true",
          "style": {
            "bold": true
          }
        },
        {
          "type": "text",
          "text": " for development", 
          "style": {
            "bold": true
          }
        }
      ]
    }
  ]
}
```

### 실제 Slack에서 보이는 모습:
```
┌─────────────────────────────────────────┐
│ Set DEBUG=false for production          │  ← 'DEBUG=false'는 굵게+취소선, 'production'은 취소선만
│ DEBUG=true for development              │  ← 모든 텍스트가 굵은 글씨
└─────────────────────────────────────────┘
```

## 5. 우리 함수의 텍스트 추출 결과

### Rich Text에서 추출된 내용:
```typescript
{
  removed: ["DEBUG=false", "production"],
  added: ["DEBUG=true", "for development"]
}
```

### 최종 conversation history 텍스트:
```
Changes: Removed: "DEBUG=false; production" | Added: "DEBUG=true; for development"
```

## Slack Rich Text vs Markdown 요약

| 구분 | Markdown | Slack Rich Text |
|------|----------|-----------------|
| 굵은 글씨 | `**text**` | `{"style": {"bold": true}}` |
| 취소선 | `~~text~~` | `{"style": {"strike": true}}` |
| 인용구 | `> text` | `{"type": "rich_text_quote"}` |
| 렌더링 | 클라이언트에서 파싱 | Slack이 직접 렌더링 |
| 스타일 조합 | 제한적 | 자유로운 조합 가능 |

**핵심**: CHOIR는 Slack의 Rich Text Block Kit을 사용하여 네이티브 Slack 스타일링으로 diff를 표시하며, 이는 markdown보다 훨씬 더 정교한 시각적 구분을 제공합니다.