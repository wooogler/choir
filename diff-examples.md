# CHOIR Diff 생성 예시

## 1. 간단한 텍스트 변경

### 입력:
```typescript
const oldText = "Deploy using manual Docker commands";
const newText = "Deploy using docker-compose with automated setup";
```

### 생성되는 Rich Text Diff 블록:
```json
{
  "type": "rich_text",
  "elements": [
    {
      "type": "rich_text_quote",
      "elements": [
        {
          "type": "text",
          "text": "Deploy using ",
          "style": {}
        },
        {
          "type": "text", 
          "text": "manual Docker commands",
          "style": { "strike": true }
        },
        {
          "type": "text",
          "text": "docker-compose with automated setup", 
          "style": { "bold": true }
        }
      ]
    }
  ]
}
```

### Slack에서 보이는 모습:
```
> Deploy using ~~manual Docker commands~~ **docker-compose with automated setup**
```

### 우리 함수가 추출하는 텍스트:
```
Changes: Removed: "manual Docker commands" | Added: "docker-compose with automated setup"
```

## 2. 복잡한 설정 변경

### 입력:
```typescript
const oldText = `Setup:
1. Install Docker
2. Run: docker run -p 3000:3000 myapp
3. Configure manually`;

const newText = `Setup:
1. Install Docker and Docker Compose
2. Create docker-compose.yml with Redis and PostgreSQL
3. Run: docker-compose up -d
4. Environment variables auto-configured`;
```

### 생성되는 Rich Text Diff 블록:
```json
{
  "type": "rich_text",
  "elements": [
    {
      "type": "rich_text_quote", 
      "elements": [
        {
          "type": "text",
          "text": "Setup:\n1. Install Docker",
          "style": {}
        },
        {
          "type": "text",
          "text": "\n2. Run: docker run -p 3000:3000 myapp\n3. Configure manually",
          "style": { "strike": true }
        },
        {
          "type": "text", 
          "text": " and Docker Compose\n2. Create docker-compose.yml with Redis and PostgreSQL\n3. Run: docker-compose up -d\n4. Environment variables auto-configured",
          "style": { "bold": true }
        }
      ]
    }
  ]
}
```

### Slack에서 보이는 모습:
```
> Setup:
> 1. Install Docker ~~2. Run: docker run -p 3000:3000 myapp
> 3. Configure manually~~ **and Docker Compose
> 2. Create docker-compose.yml with Redis and PostgreSQL  
> 3. Run: docker-compose up -d
> 4. Environment variables auto-configured**
```

### 우리 함수가 추출하는 텍스트:
```
Changes: Removed: "2. Run: docker run -p 3000:3000 myapp; 3. Configure manually" | Added: "and Docker Compose; 2. Create docker-compose.yml with Redis and PostgreSQL; 3. Run: docker-compose up -d; 4. Environment variables auto-configured"
```

## 3. 인라인 볼드가 있는 변경

### 입력:
```typescript
const oldText = "Set *DEBUG=false* for production";
const newText = "Set *DEBUG=true* and *LOG_LEVEL=verbose* for development";
```

### 생성되는 Rich Text Diff 블록:
```json
{
  "type": "rich_text",
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
          "style": { "bold": true, "strike": true }
        },
        {
          "type": "text", 
          "text": " for ",
          "style": {}
        },
        {
          "type": "text",
          "text": "production",
          "style": { "strike": true }
        },
        {
          "type": "text",
          "text": "DEBUG=true",
          "style": { "bold": true }
        },
        {
          "type": "text",
          "text": " and ",
          "style": { "bold": true }
        },
        {
          "type": "text",
          "text": "LOG_LEVEL=verbose",
          "style": { "bold": true }
        },
        {
          "type": "text",
          "text": " for development",
          "style": { "bold": true }
        }
      ]
    }
  ]
}
```

### Slack에서 보이는 모습:
```
> Set ~~**DEBUG=false**~~ **DEBUG=true** and **LOG_LEVEL=verbose** ~~for production~~ **for development**
```

### 우리 함수가 추출하는 텍스트:
```
Changes: Removed: "DEBUG=false for production" | Added: "DEBUG=true and LOG_LEVEL=verbose for development"
```

## 4. 실제 문서 업데이트 시나리오

### 입력 (마크다운에서 Slack 텍스트로 변환 후):
```typescript
const oldText = `Prerequisites:
• Docker installed
• Basic knowledge of containers

Quick Start:
Run: npm start`;

const newText = `Prerequisites:
• Docker and Docker Compose installed  
• Basic knowledge of containers and orchestration
• Node.js 18+ for development

Quick Start:
1. Copy .env.example to .env
2. Run: docker-compose up
3. Visit http://localhost:3000`;
```

### 우리 함수가 추출하는 텍스트:
```
Changes: Removed: "Docker installed; Basic knowledge of containers; Run: npm start" | Added: "Docker and Docker Compose installed; Basic knowledge of containers and orchestration; Node.js 18+ for development; 1. Copy .env.example to .env; 2. Run: docker-compose up; 3. Visit http://localhost:3000"
```

## 5. Conversation History에서 AI가 보는 전체 메시지

```
User: How do I set up the development environment?
CHOIR: You need to install Docker and configure the application. Let me check our latest documentation...
CHOIR: ✅ Document Updated: setup.md by Alice - Section: Development Setup (view at https://github.com/repo/setup.md) - Changes: Removed: "Docker installed; Basic knowledge of containers; Run: npm start" | Added: "Docker and Docker Compose installed; Basic knowledge of containers and orchestration; Node.js 18+ for development; 1. Copy .env.example to .env; 2. Run: docker-compose up; 3. Visit http://localhost:3000" [View Changes] [View File]
User: What's the difference from the old setup?
CHOIR: The main differences from the old setup are:
1. **Docker Compose requirement**: Now requires Docker Compose in addition to Docker
2. **Enhanced prerequisites**: Added Node.js 18+ requirement and knowledge of orchestration
3. **Structured startup process**: Replaced simple "npm start" with a 3-step process involving environment setup and Docker Compose
4. **Local development URL**: Now includes specific localhost URL for accessing the application

The new setup is more comprehensive and uses container orchestration instead of manual commands.
```

## 핵심 특징

1. **토큰 기반 diff**: 단어와 구문 단위로 변경사항 감지
2. **Rich text 스타일링**: `strike` (제거), `bold` (추가)로 시각적 구분
3. **인라인 볼드 지원**: 마크다운 `*text*` 구문 처리
4. **Quote 스타일링**: 다른 콘텐츠와 구분되는 인용구 형태
5. **실제 내용 추출**: AI가 구체적인 변경사항을 이해할 수 있도록 텍스트 추출

이제 AI가 **정확한 변경사항**을 바탕으로 훨씬 더 유용한 답변을 제공할 수 있습니다! 🎯