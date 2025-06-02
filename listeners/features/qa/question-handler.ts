import { generateSessionId, SessionType, storeSessionData } from "services/common";
import { answerQuestion } from "services/llm";
import { createGitbookSectionLink, getManagers, getUserName, getQAChannel, getChannelName } from "services/slack";
import { getWorkspaceId } from "services/slack";
import { SlackMessage } from "services/slack";
import { VectorStoreService } from "services/vector/main-service";
import { convertMarkdownToSlackText } from "services/document/markdown";
import { DocumentEnhancer } from "services/web-content/document-enhancer";
import { formatSectionPathWithLinks } from "services/document/section-utils";

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

    // 워크스페이스 이름 가져오기
    let workspaceName = "";
    try {
      const teamInfo = await client.team.info();
      workspaceName = teamInfo.team?.name || "";
    } catch (error) {
      logger.warn("Could not get workspace name:", error);
    }

    // 응답 생성
    let response = await answerQuestion(
      userMessage,
      historyResult.messages || [],
      relevantDocs,
      client,
      workspaceName
    );

    // 마크다운을 Slack 형식으로 변환
    response = await convertMarkdownToSlackText(response || '');

    // 공유용 깔끔한 응답 (참조 문구 없이)
    const cleanResponseForSharing = response;
    
    // 실제 표시용 응답 (참조 문구 포함)
    const displayResponse = response + "\n\nIf you'd like to read the original document, please refer to the sources linked in the reply.";

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
      text: cleanResponseForSharing,
      ts: (Math.floor(Date.now() / 1000) + "." + Date.now() % 1000),
    });

    // 타임스탬프별로 메시지 정렬 (내림차순)
    validMessages.sort((a: SlackMessage, b: SlackMessage) => {
      const tsA = parseFloat(a.ts);
      const tsB = parseFloat(b.ts);
      return tsB - tsA;
    });

    // 워크스페이스 ID와 Q&A 채널 정보 가져오기
    const workspaceId = await getWorkspaceId(client);
    const qaChannelId = await getQAChannel(workspaceId, client);
    
    // Q&A 채널 표시용 형식 지정
    let qaChannelText = "";
    let qaChannelName = "";
    if (qaChannelId) {
      try {
        const channelInfo = await client.conversations.info({ channel: qaChannelId });
        qaChannelName = channelInfo.channel?.name || "unknown";
        qaChannelText = `#${qaChannelName}`;
      } catch (error) {
        logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
        qaChannelText = "Unknown channel";
        qaChannelName = "";
      }
    } else {
      qaChannelText = "No Q&A channel configured";
      qaChannelName = "";
    }

    // 세션 ID 생성
    const sessionId = generateSessionId("consultation");

    // 세션 데이터 저장 (Q&A 채널 정보 포함, 공유용으로는 깔끔한 응답 사용)
    storeSessionData(
      sessionId,
      {
        stakeholders: Array.from(historyUsers),
        validMessages: validMessages,
        qaChannelId: qaChannelId,
        originalQuestion: userMessage,
        botResponse: cleanResponseForSharing,
        originalChannelId: event.channel,
      },
      SessionType.CONSULTATION
    );

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

    // 응답 메시지 전송 (Ask Managers 버튼 없이)
    const responseBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: displayResponse
        }
      }
    ];

    const result = await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: displayResponse,
      mrkdwn: true,
      blocks: responseBlocks,
      unfurl_links: false,
      unfurl_media: false
    });

    // 응답 메시지가 완전히 전송된 후 약간의 지연을 두고 공유 버튼을 전송
    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms 지연
    
    // 공유 버튼 요소들 생성
    const actionElements = [];
    
    // Q&A 채널이 설정된 경우에만 Q&A 채널 버튼 추가
    if (qaChannelId && qaChannelName) {
      actionElements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: "Ask the Q&A Channel",
          emoji: true,
        },
        style: "primary",
        action_id: "ask_to_channel_modal",
        value: sessionId,
      });
    }
    
    // 개인 메시지 버튼은 항상 추가
    actionElements.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Ask in Private",
        emoji: true,
      },
      action_id: "ask_to_others_modal",
      value: sessionId,
    });
    
    // 버튼이 있는 경우에만 공유 메시지 표시
    if (actionElements.length > 0) {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        text: `💬 Want to discuss this with others?`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `💬 Want to discuss this with others?`
            }
          },
          {
            type: "actions",
            elements: actionElements,
          }
        ]
      });
    }

    // 관련 문서 정보를 응답의 스레드에 추가
    if (result.ts && relevantDocs.length > 0) {
      // 문서 정보를 스레드용으로 포맷
      const documentInfo = await Promise.all(relevantDocs
        .map(async (doc, index) => {
          const metadata = doc.metadata;
          
          // Source 정보를 [파일명] > [섹션명] 형태로 표시
          let sourceInfo = "";
          if (metadata.fileName || metadata.sectionName) {
            const parts = [];
            
            // 파일명 (링크 포함)
            if (metadata.fileName && metadata.githubUrl) {
              parts.push(`<${metadata.githubUrl}|${metadata.fileName}>`);
            } else if (metadata.fileName) {
              parts.push(metadata.fileName);
            }
            
            // 섹션명 (링크 포함)
            if (metadata.sectionName) {
              if (metadata.githubUrl && metadata.headingPath) {
                // GitHub 링크에 헤딩 앵커 추가 (headingPath가 배열인 경우 조인)
                const headingString = Array.isArray(metadata.headingPath) 
                  ? metadata.headingPath.join('-') 
                  : metadata.headingPath;
                const headingAnchor = headingString.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
                const sectionUrl = `${metadata.githubUrl}#${headingAnchor}`;
                parts.push(`<${sectionUrl}|${metadata.sectionName}>`);
              } else {
                parts.push(metadata.sectionName);
              }
            }
            
            if (parts.length > 0) {
              sourceInfo = `*Source:* ${parts.join(' > ')}\n`;
            }
          }

          // 문서 내용에서 메타데이터 부분 제거
          let contentPreview = doc.pageContent;
          
          // "File: xxx\nPath: xxx\n\n" 패턴 제거
          contentPreview = contentPreview.replace(/^File:.*?\n.*?\n\n/, '');
          
          // "(To be continued)" 제거
          contentPreview = contentPreview.replace(/\(To be continued\)/g, '');
          
          // 길이 제한 및 Slack 형식 변환
          if (contentPreview.length > 500) {
            contentPreview = `${contentPreview.substring(0, 500)}...`;
          }
          
          contentPreview = await convertMarkdownToSlackText(contentPreview);

          return `*Reference ${index + 1}*\n${sourceInfo}\n\`\`\`${contentPreview}\`\`\`\n`;
        }));

      // 문서 정보를 응답의 스레드에 추가
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: result.ts,
        text: `${documentInfo.join("\n")}`,
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