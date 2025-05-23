import { generateSessionId, SessionType, storeSessionData } from "services/common";
import { generateCompletion } from "services/llm";
import { createGitbookSectionLink, getManagers, getUserName } from "services/slack";
import { getWorkspaceId } from "services/slack";
import { SlackMessage } from "services/slack";
import { VectorStoreService } from "services/vector/main-service";
import { convertMarkdownToSlackText } from "services/document/markdown";
import { DocumentEnhancer } from "services/web-content/document-enhancer";

/**
 * 질문 메시지 처리
 */
export async function handleQuestionMessage(client: any, event: any, userMessage: string, logger: any) {
  let loadingMessageTs: string | undefined;
  
  try {
    // 로딩 메시지 게시
    const loadingMessage = await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: "Searching relevant documents and generating response... :mag: :brain:",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":mag: Searching relevant documents and analyzing context..."
          }
        }
      ]
    });
    loadingMessageTs = loadingMessage.ts;

    // 컨텍스트를 위한 메시지 히스토리 가져오기 (최대 5개 이전 메시지)
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 5,
    });

    // 벡터 스토어에서 관련 문서 가져오기
    const vectorStore = VectorStoreService.getInstance();
    let relevantDocs = await vectorStore.similaritySearch(userMessage, 3);

    // 웹 콘텐츠가 있는 문서들의 pageContent를 확장
    relevantDocs = relevantDocs.map(doc => {
      if (doc.metadata.webContent && doc.metadata.webContent.length > 0) {
        // 웹 콘텐츠를 포함한 전체 콘텐츠로 pageContent 확장
        const enhancedContent = DocumentEnhancer.getFullContentForSearch(doc);
        return {
          ...doc,
          pageContent: enhancedContent
        };
      }
      return doc;
    });

    // 응답 생성
    let response = await generateCompletion(
      userMessage,
      historyResult.messages || [],
      relevantDocs
    );

    // 마크다운을 Slack 형식으로 변환
    response = await convertMarkdownToSlackText(response || '');

    // 대화 히스토리에서 모든 고유 사용자 ID 추출
    const historyUsers = new Set<string>();
    historyUsers.add(event.user); // 현재 메시지를 보낸 사용자 추가
    
    // 대화 히스토리의 다른 사용자 추가
    (historyResult.messages || []).forEach((msg: any) => {
      if (msg.user && typeof msg.user === 'string') {
        historyUsers.add(msg.user);
      }
    });

    // 히스토리 메시지를 validMessages 형식으로 변환
    const validMessages = (historyResult.messages || []).map((msg: any) => ({
      userId: msg.user || msg.bot_id || "unknown",
      username: msg.username || (msg.bot_id ? "CHOIR" : "User"),
      text: msg.text,
      ts: msg.ts
    }));
    
    // 현재 메시지가 포함되어 있는지 확인 (너무 최근이면 히스토리에 포함되지 않을 수 있음)
    const currentMessageIncluded = validMessages.some((msg: any) => msg.ts === event.ts);
    if (!currentMessageIncluded) {
      validMessages.push({
        userId: event.user,
        username: "User",
        text: userMessage,
        ts: event.ts,
      });
    }

    // 봇의 현재 응답도 validMessages에 추가
    validMessages.push({
      userId: "bot",
      username: "CHOIR",
      text: response,
      ts: (Math.floor(Date.now() / 1000) + "." + Date.now() % 1000),
    });

    // 타임스탬프별로 메시지 정렬 (내림차순)
    validMessages.sort((a: SlackMessage, b: SlackMessage) => {
      const tsA = parseFloat(a.ts);
      const tsB = parseFloat(b.ts);
      return tsB - tsA;
    });

    // 워크스페이스 ID와 매니저 목록 가져오기
    const workspaceId = await getWorkspaceId(client);
    const managers = getManagers(workspaceId);
    
    // 매니저 표시용 형식 지정
    let managersText = "";
    if (managers && managers.length > 0) {
      // 매니저 이름 가져오기
      const managerNames = await Promise.all(
        managers.map(async (uid: string) => {
          const name = await getUserName(uid, client);
          return `*${name}*`;
        })
      );
      managersText = managerNames.join(", ");
    } else {
      managersText = "No managers available";
    }

    // 세션 ID 생성
    const sessionId = generateSessionId("consultation");

    // 세션 데이터 저장
    storeSessionData(
      sessionId,
      {
        stakeholders: Array.from(historyUsers),
        validMessages: validMessages,
      },
      SessionType.CONSULTATION
    );

    // 채널에 응답 메시지 전송
    const mainBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: response
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Would you like to discuss this question with managers? ${managersText}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Ask Managers",
              emoji: true,
            },
            style: "primary",
            action_id: "start_consultation",
            value: sessionId,
          },
        ],
      }
    ];

    // 질문이 스레드에서 왔는지 확인
    const isThreadQuestion = event.thread_ts !== undefined;

    // 로딩 메시지 삭제
    if (loadingMessageTs) {
      try {
        await client.chat.delete({
          channel: event.channel,
          ts: loadingMessageTs
        });
      } catch (error) {
        logger.warn("Failed to delete loading message:", error);
      }
    }

    // 응답 메시지 전송
    const result = await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: response,
      mrkdwn: true,
      blocks: mainBlocks,
      unfurl_links: false,
      unfurl_media: false
    });

    // 관련 문서 정보를 응답의 스레드에 추가
    if (result.ts && relevantDocs.length > 0) {
      // 문서 정보를 스레드용으로 포맷
      const documentInfo = await Promise.all(relevantDocs
        .map(async (doc, index) => {
          const metadata = doc.metadata;
          const fileInfo = metadata.fileName ? 
            `*File:* <${metadata.githubUrl}|${metadata.fileName}>\n` : "";
          const sectionInfo = metadata.sectionName ? 
            `*Section:* <${metadata.githubUrl}#${metadata.sectionName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')}|${metadata.sectionName}>\n` : 
            "*Section:* Main Content\n";

          // 문서 내용 미리보기를 Slack 형식으로 변환
          let contentPreview =
            doc.pageContent.length > 500
              ? `${doc.pageContent.substring(0, 500)}...`
              : doc.pageContent;
          
          contentPreview = await convertMarkdownToSlackText(contentPreview);

          return `*Reference Document ${index + 1}*\n${fileInfo}${sectionInfo}*Related Content:*\n\`\`\`${contentPreview}\`\`\`\n`;
        }));

      // 문서 정보를 응답의 스레드에 추가
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: result.ts,
        text: `*Reference Document Information:*\n\n${documentInfo.join("\n")}`,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false
      });
    }

    return true;
  } catch (error) {
    // 에러 발생 시 로딩 메시지 삭제
    if (loadingMessageTs) {
      try {
        await client.chat.delete({
          channel: event.channel,
          ts: loadingMessageTs
        });
      } catch (deleteError) {
        logger.warn("Failed to delete loading message:", deleteError);
      }
    }

    // 에러 메시지 표시
    await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: "Sorry, I encountered an error while processing your question. Please try again. :warning:"
    });

    logger.error("Error handling question message:", error);
    throw error;
  }
} 