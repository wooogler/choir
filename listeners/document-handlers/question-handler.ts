import type { SlackMessage } from "../../services/slack-utils";
import {
  createSlackMessageWithName,
  formatSlackMessageBlock,
  getWorkspaceId,
  getManagers,
  createGitbookSectionLink,
} from "../../services/slack-utils";
import { VectorStoreService } from "../../services/index";
import { generateCompletion } from "../../services/completions";
import { generateSessionId, storeSessionData, SessionType } from "../../services/session-store";

/**
 * 질문 메시지 처리
 */
export async function handleQuestionMessage(client: any, event: any, userMessage: string, logger: any) {
  try {
    // 컨텍스트를 위한 메시지 히스토리 가져오기 (최대 5개 이전 메시지)
    const historyResult = await client.conversations.history({
      channel: event.channel,
      limit: 5,
    });

    // 벡터 스토어에서 관련 문서 가져오기
    const vectorStore = VectorStoreService.getInstance();
    const relevantDocs = await vectorStore.similaritySearch(userMessage, 3);

    // 응답 생성
    const response = await generateCompletion(
      userMessage,
      historyResult.messages || [],
      relevantDocs
    );

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
      managersText = managers.map((uid: string) => `<@${uid}>`).join(", ");
    } else {
      managersText = "매니저가 없습니다";
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
          text: `이 질문에 대해 매니저와 상담하시겠습니까? ${managersText}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "직접 질문하기",
              emoji: true,
            },
            style: "primary",
            action_id: "start_consultation",
            value: sessionId,
          },
        ],
      }
    ];

    // DM이면 스레드 없이, 채널이라면 스레드로 응답
    const result = await client.chat.postMessage({
      channel: event.channel,
      ...(event.channel_type !== "im" && event.ts ? { thread_ts: event.ts } : {}),
      text: response,
      mrkdwn: true,
      blocks: mainBlocks
    });

    // 관련 문서 정보를 스레드에 추가
    if (result.ts && relevantDocs.length > 0) {
      // 문서 정보를 스레드용으로 포맷
      const documentInfo = relevantDocs
        .map((doc, index) => {
          const metadata = doc.metadata;
          const sectionInfo = metadata.sectionName
            ? `*Section:* ${metadata.sectionName}\n`
            : "";
          const gitbookLink = metadata.sectionName
            ? `*GitBook Link:* <${createGitbookSectionLink(metadata.sectionName, metadata.fileName)}|${
                metadata.sectionName || "View Document"
              }>\n`
            : "";
          const githubLink = metadata.githubUrl
            ? `*GitHub Link:* <${metadata.githubUrl}|View Source Code>\n`
            : "";

          // 문서 내용 미리보기
          const contentPreview =
            doc.pageContent.length > 500
              ? `${doc.pageContent.substring(0, 500)}...`
              : doc.pageContent;

          return `*참고 문서 ${
            index + 1
          }*\n${sectionInfo}${gitbookLink}${githubLink}*관련 내용:*\n\`\`\`${contentPreview}\`\`\`\n`;
        })
        .join("\n");

      // 문서 정보 스레드에 추가
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: result.ts,
        text: `*참고 문서 정보:*\n\n${documentInfo}\n\n더 자세한 정보는 위 링크를 확인해주세요.`,
        mrkdwn: true,
      });
    }

    return true;
  } catch (error) {
    logger.error("Error handling question message:", error);
    throw error;
  }
} 