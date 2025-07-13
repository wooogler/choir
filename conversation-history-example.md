# Conversation History 개선 예시

## Before (기존)
```
User: How do I set up Docker for our project?
CHOIR: Searching relevant documents and generating response... :mag: :brain:
CHOIR: ✅ Analyzed 3 messages to extract knowledge  
CHOIR: You can set up Docker by creating a docker-compose.yml file...
CHOIR: ✅ Document Updated: deploy.md by *Alice* (with CHOIR)
User: What exactly was changed in the deployment guide?
CHOIR: I can see that deploy.md was updated, but I don't have the specific details...
```

**문제점**: AI가 구체적인 변경사항을 모름

## After (개선)
```
User: How do I set up Docker for our project?
CHOIR: Searching relevant documents and generating response... 🔍 🧠
CHOIR: ✅ Analysis Complete - 3 messages analyzed [View Messages]
CHOIR: You can set up Docker by creating a docker-compose.yml file...
CHOIR: ✅ Document Updated: deploy.md by Alice - Section: Docker Setup (view at https://github.com/repo/deploy.md) - Changes: +15 lines, -2 lines (Preview: "Add docker-compose.yml configuration with Redis and PostgreSQL services") [View Changes] [View File]
User: What exactly was changed in the deployment guide?  
CHOIR: Based on the recent update to deploy.md, Alice added Docker setup instructions including a docker-compose.yml configuration with Redis and PostgreSQL services. The changes included 15 new lines with specific service configurations...
```

**개선점**: AI가 정확한 변경사항과 맥락을 이해함

## Conversation History에서 AI가 얻는 정보

### 기존 (부족한 정보)
- 문서가 업데이트되었다는 사실만
- 파일명과 사용자명
- 변경 내용 전혀 모름

### 개선 (풍부한 정보)  
- 어떤 섹션이 변경되었는지
- 변경된 라인 수와 미리보기
- GitHub URL로 접근 가능
- 사용자가 사용할 수 있는 버튼들
- 실제 변경사항의 요약

이제 AI가 훨씬 더 정확하고 구체적인 대답을 할 수 있습니다!