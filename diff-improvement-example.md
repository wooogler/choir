# Diff Summary 개선 예시

## Before (라인 수 기반)

### Conversation History에서 AI가 보는 것:
```
User: How do I deploy with Docker?
CHOIR: You can use docker-compose for deployment...
CHOIR: ✅ Document Updated: deploy.md by Alice - Section: Docker Setup (view at github.com/repo/deploy.md) - Changes: +15 lines, -2 lines (Preview: "Add docker-compose.yml configuration") [View Changes] [View File]
User: What did Alice change exactly?
CHOIR: I can see that Alice made changes to the deploy.md file with 15 additions and 2 deletions, but I don't have the specific content details.
```

**문제점**: AI가 라인 수만 알고 실제 내용은 모름

## After (실제 내용 기반)

### Conversation History에서 AI가 보는 것:
```
User: How do I deploy with Docker?
CHOIR: You can use docker-compose for deployment...
CHOIR: ✅ Document Updated: deploy.md by Alice - Section: Docker Setup (view at github.com/repo/deploy.md) - Changes: Removed: "Use manual Docker commands for deployment" | Added: "Use docker-compose.yml with Redis and PostgreSQL services; Set REDIS_URL=redis://localhost:6379; Configure database connection in .env file" [View Changes] [View File]
User: What did Alice change exactly?
CHOIR: Alice updated the deployment section to replace manual Docker commands with a docker-compose.yml setup that includes Redis and PostgreSQL services. She added configuration for REDIS_URL and database connections via environment variables.
```

**개선점**: AI가 정확한 변경사항과 기술적 세부사항을 이해함

## Rich Text Diff 구조 처리

### Slack Rich Text Diff Block 예시:
```typescript
{
  type: 'rich_text',
  elements: [
    {
      type: 'rich_text_quote',
      elements: [
        {
          type: 'text',
          text: 'Old deployment method: ',
          style: { strike: true }  // 제거된 내용 (취소선)
        },
        {
          type: 'text', 
          text: 'Use manual Docker commands',
          style: { strike: true }
        },
        {
          type: 'text',
          text: 'New deployment method: ',
          style: { bold: true }    // 추가된 내용 (굵게)
        },
        {
          type: 'text',
          text: 'Use docker-compose.yml with services',
          style: { bold: true }
        }
      ]
    }
  ]
}
```

### 텍스트 추출 결과:
- **Removed**: "Old deployment method: Use manual Docker commands"
- **Added**: "New deployment method: Use docker-compose.yml with services"

## 실제 사용 시나리오

### 1. 설정 변경
```
Changes: Removed: "DEBUG=false" | Added: "DEBUG=true; LOG_LEVEL=verbose; ENABLE_METRICS=true"
```

### 2. 문서 구조 변경  
```
Changes: Removed: "Quick Start section with basic setup" | Added: "Prerequisites section; Detailed installation steps; Environment configuration guide"
```

### 3. 코드 예제 업데이트
```
Changes: Removed: "const client = new Client()" | Added: "const client = new Client({ apiKey: process.env.API_KEY, timeout: 5000 })"
```

## AI가 얻는 이점

1. **구체적인 맥락 이해**: "Redis 설정이 추가되었네요"
2. **기술적 세부사항 파악**: "환경변수 설정 방식이 바뀌었군요"
3. **변경사항 기반 답변**: "새로운 docker-compose 설정을 사용하면..."
4. **연관 질문 처리**: "이전 배포 방식과 비교하면..."

이제 AI가 **변경사항의 실제 내용**을 바탕으로 훨씬 더 정확하고 유용한 답변을 제공할 수 있습니다! 🎯