import { SessionType, generateSessionId, storeSessionData } from 'services/common';
import { logQuestionProcessing } from 'services/common/user-interaction-logger';
import { convertMarkdownToSlackText } from 'services/document/markdown';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import { QuestionProcessor } from 'services/qa/question-processor';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import {
  createGitbookSectionLink,
  getCHOIRUsers,
  getChannelName,
  getFilteredConversationHistory,
  getManagers,
  getQAChannel,
  getUserName,
  getWorkspaceId,
} from 'services/slack';
import type { SlackMessage } from 'services/slack';
import { createEnhancedMessage } from 'services/slack/message-text-utils';

/**
 * 질문 메시지 처리
 */
export async function handleQuestionMessage(client: any, event: any, userMessage: string, logger: any) {
  const startTime = Date.now();
  let loadingMessageTs: string | undefined;
  let relevantDocs: any[] = [];

  try {
    // 로딩 메시지 게시
    const loadingMessageData = createEnhancedMessage({
      text: 'Searching relevant documents and generating response... :mag: :brain:',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':mag: Searching relevant documents and analyzing context...',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
        },
      ],
    });

    const loadingMessage = await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      ...loadingMessageData,
    });
    loadingMessageTs = loadingMessage.ts;

    // Get workspace info and CHOIR users for filtering
    const workspaceId = await getWorkspaceId(client);
    const choirUsers = await getCHOIRUsers(workspaceId);

    // Get filtered conversation history (excludes Non-CHOIR users)
    const messages = await getFilteredConversationHistory(client, event, choirUsers, {
      timeLimit: 5, // 5 minutes
      messageLimit: 10, // fetch up to 10 messages
      maxResults: 5, // return up to 5 messages
    });

    // Create historyResult object for compatibility with existing code
    const historyResult = { messages };

    // QuestionProcessor로 질문 처리
    const questionProcessor = new QuestionProcessor();
    const processingResult = await questionProcessor.processQuestion(
      userMessage,
      historyResult.messages || [],
      client,
      logger,
    );

    const {
      answerResult,
      relevantDocs: processedDocs,
      workspaceName,
      organizationName,
      organizationDescription,
    } = processingResult;
    relevantDocs = processedDocs;

    // 마크다운을 Slack 형식으로 변환
    const response = await convertMarkdownToSlackText(answerResult.response || '');

    // 공유용 깔끔한 응답 (참조 문구 없이)
    const cleanResponseForSharing = response;

    // 실제 표시용 응답 (참조 문구 포함)
    const displayResponse = answerResult.canAnswer
      ? response + "\n\nIf you'd like to read the original document, please refer to the sources linked in the reply."
      : response;

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
      userId: msg.user || msg.bot_id || 'unknown',
      username: msg.username || (msg.bot_id ? 'CHOIR' : 'User'),
      text: msg.text,
      ts: msg.ts,
    }));

    // 현재 메시지가 포함되어 있는지 확인 (너무 최근이면 히스토리에 포함되지 않을 수 있음)
    const currentMessageIncluded = validMessages.some((msg: any) => msg.ts === event.ts);
    if (!currentMessageIncluded) {
      validMessages.push({
        userId: event.user,
        username: 'User',
        text: userMessage,
        ts: event.ts,
      });
    }

    // 봇의 현재 응답도 validMessages에 추가
    validMessages.push({
      userId: 'bot',
      username: 'CHOIR',
      text: cleanResponseForSharing,
      ts: Math.floor(Date.now() / 1000) + '.' + (Date.now() % 1000),
    });

    // 타임스탬프별로 메시지 정렬 (내림차순)
    validMessages.sort((a: SlackMessage, b: SlackMessage) => {
      const tsA = Number.parseFloat(a.ts || '0');
      const tsB = Number.parseFloat(b.ts || '0');
      return tsB - tsA;
    });

    // Q&A 채널 정보 가져오기 (workspaceId already defined above)
    const qaChannelId = await getQAChannel(workspaceId, client);

    // Q&A 채널 표시용 형식 지정
    let qaChannelText = '';
    let qaChannelName = '';
    if (qaChannelId) {
      try {
        const channelInfo = await client.conversations.info({ channel: qaChannelId });
        qaChannelName = channelInfo.channel?.name || 'unknown';
        qaChannelText = `#${qaChannelName}`;
      } catch (error) {
        logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
        qaChannelText = 'Unknown channel';
        qaChannelName = '';
      }
    } else {
      qaChannelText = 'No Q&A channel configured';
      qaChannelName = '';
    }

    // 세션 ID 생성
    const sessionId = generateSessionId('consultation');

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
        canAnswer: answerResult.canAnswer,
      },
      SessionType.DOCUMENT_UPDATE,
    );

    // 질문이 스레드에서 왔는지 확인
    const isThreadQuestion = event.thread_ts !== undefined;

    // 로딩 메시지 삭제
    if (loadingMessageTs) {
      try {
        await client.chat.delete({
          channel: event.channel,
          ts: loadingMessageTs,
        });
      } catch (error) {
        logger.warn('Failed to delete loading message:', error);
      }
    }

    // 응답 메시지 전송 (Ask Managers 버튼 없이)
    const responseBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: displayResponse,
        },
        block_id: createCHOIRBlockId(CHOIRMessageType.RESPONSE),
      },
    ];

    const messageResult = await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: displayResponse,
      mrkdwn: true,
      blocks: responseBlocks,
      unfurl_links: false,
      unfurl_media: false,
    });

    // 응답 메시지가 완전히 전송된 후 약간의 지연을 두고 공유 버튼을 전송
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 1초 지연

    // 공유 버튼 요소들 생성
    const actionElements = [];

    // Q&A 채널이 설정된 경우에만 Q&A 채널 버튼 추가
    if (qaChannelId && qaChannelName) {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Ask the Q&A Channel',
          emoji: true,
        },
        style: 'primary',
        action_id: 'ask_to_channel_modal',
        value: sessionId,
      });
    }

    // 개인 메시지 버튼은 항상 추가
    actionElements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: 'Ask in Private',
        emoji: true,
      },
      action_id: 'ask_to_others_modal',
      value: sessionId,
    });

    // 버튼이 있는 경우에만 공유 메시지 표시
    if (actionElements.length > 0) {
      // 답변 가능 여부에 따라 다른 메시지 제공
      const ephemeralText = answerResult.canAnswer
        ? '💬 Not satisfied with my answer? Want to discuss this further or get more insights?'
        : "💬 I couldn't find this information in our documentation. Would you like to ask others directly?";

      // Create enhanced message with button information
      const ephemeralMessageData = createEnhancedMessage({
        text: ephemeralText,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ephemeralText,
            },
          },
          {
            type: 'actions',
            elements: actionElements,
          },
        ],
      }, {
        buttons: actionElements.map(element => ({
          text: element.text.text,
          style: element.style as any
        }))
      });

      await client.chat.postEphemeral({
        channel: event.channel,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        user: event.user,
        ...ephemeralMessageData,
      });
    }

    // 관련 문서 정보를 응답의 스레드에 추가 (답변 가능한 경우에만)
    if (messageResult.ts && relevantDocs.length > 0 && answerResult.canAnswer) {
      // 문서 정보를 스레드용으로 포맷
      const documentInfo = await Promise.all(
        relevantDocs.map(async (doc, index) => {
          const metadata = doc.metadata;

          // Source 정보를 [파일명] > [섹션명] 형태로 표시
          let sourceInfo = '';
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
              if (metadata.githubUrl) {
                // GitHub 링크에 헤딩 앵커 추가 (sectionName 기반)
                const headingAnchor = metadata.sectionName
                  .toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^\w-]/g, '');
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
        }),
      );

      // 문서 정보를 응답의 스레드에 추가
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: messageResult.ts,
        text: `${documentInfo.join('\n')}`,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
    }

    // 로그: 성공적인 질문 처리
    const totalProcessingTime = Date.now() - startTime;

    // 질문 처리 로그
    await logQuestionProcessing(
      event.user,
      workspaceId,
      event.channel,
      event.channel_type || 'public',
      !!event.thread_ts,
      totalProcessingTime,
      true,
      userMessage,
      relevantDocs.length,
      answerResult.canAnswer,
      {
        sessionId,
        workspaceName,
        organizationName: organizationName || undefined,
        qaChannelId,
        qaChannelName,
        responseLength: response.length,
        botResponse: cleanResponseForSharing,
        historyMessageCount: historyResult.messages?.length || 0,
        historyUsers: Array.from(historyUsers),
        hasWebContent: relevantDocs.some((doc) => doc.metadata.webContent && doc.metadata.webContent.length > 0),
        relevantDocs: relevantDocs.map((doc: any) => ({
          fileName: doc.metadata.fileName,
          headingPath: doc.metadata.headingPath,
          hasWebContent: !!(doc.metadata.webContent && doc.metadata.webContent.length > 0),
          // 소스 내용 추가 (webContent가 있으면 1000자 제한, 없으면 전체 내용)
          sourceContent:
            doc.metadata.webContent && doc.metadata.webContent.length > 0
              ? doc.pageContent.length > 1000
                ? doc.pageContent.substring(0, 1000) + '...'
                : doc.pageContent
              : doc.pageContent,
          // 메타데이터 정보도 포함
          metadata: {
            fileName: doc.metadata.fileName,
            sectionName: doc.metadata.sectionName,
            headingPath: doc.metadata.headingPath,
            githubUrl: doc.metadata.githubUrl,
            webContentLength: doc.metadata.webContent ? doc.metadata.webContent.length : 0,
          },
        })),
      },
      client,
    );

    logger.info(`Question answered successfully for user ${event.user} in channel ${event.channel}`);
    return true;
  } catch (error) {
    logger.error('Error in handleQuestionMessage:', error);

    // 로그: 질문 처리 실패
    const workspaceId = await getWorkspaceId(client);

    await logQuestionProcessing(
      event.user,
      workspaceId,
      event.channel,
      event.channel_type || 'public',
      !!event.thread_ts,
      Date.now() - startTime,
      false,
      userMessage,
      relevantDocs.length,
      false,
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
        // relevantDocs가 있는 경우 소스 내용도 포함
        ...(relevantDocs.length > 0 && {
          relevantDocs: relevantDocs.map((doc: any) => ({
            fileName: doc.metadata.fileName,
            headingPath: doc.metadata.headingPath,
            hasWebContent: !!(doc.metadata.webContent && doc.metadata.webContent.length > 0),
            // 소스 내용 추가 (webContent가 있으면 1000자 제한, 없으면 전체 내용)
            sourceContent:
              doc.metadata.webContent && doc.metadata.webContent.length > 0
                ? doc.pageContent.length > 1000
                  ? doc.pageContent.substring(0, 1000) + '...'
                  : doc.pageContent
                : doc.pageContent,
            // 메타데이터 정보도 포함
            metadata: {
              fileName: doc.metadata.fileName,
              sectionName: doc.metadata.sectionName,
              headingPath: doc.metadata.headingPath,
              githubUrl: doc.metadata.githubUrl,
              webContentLength: doc.metadata.webContent ? doc.metadata.webContent.length : 0,
            },
          })),
        }),
      },
      client,
    );

    // 로딩 메시지가 있으면 삭제
    if (loadingMessageTs) {
      try {
        await client.chat.delete({
          channel: event.channel,
          ts: loadingMessageTs,
        });
      } catch (deleteError) {
        logger.warn('Failed to delete loading message:', deleteError);
      }
    }

    // 에러 메시지 전송
    await client.chat.postMessage({
      channel: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text: 'Sorry, I encountered an error while processing your question. Please try again later.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Sorry, I encountered an error while processing your question. Please try again later.',
          },
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
        },
      ],
    });

    return false;
  }
}
