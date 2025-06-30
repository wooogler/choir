import { Logger } from 'services/common/logger';
import { convertMarkdownToSlackText } from 'services/document/markdown';
import type { SlackMessage } from 'services/slack';

export class ResponseFormatter {
  async formatResponse(answerResult: any): Promise<{
    displayResponse: string;
    cleanResponseForSharing: string;
  }> {
    try {
      // 마크다운을 Slack 형식으로 변환
      const response = await convertMarkdownToSlackText(answerResult.response || '');

      // 공유용 깔끔한 응답 (참조 문구 없이)
      const cleanResponseForSharing = response;

      // 실제 표시용 응답 (참조 문구 포함)
      const displayResponse = answerResult.canAnswer
        ? response + "\n\nIf you'd like to read the original document, please refer to the sources linked in the reply."
        : response;

      return { displayResponse, cleanResponseForSharing };
    } catch (error) {
      Logger.error('Error formatting response', error as Error);
      return {
        displayResponse: 'Error formatting response',
        cleanResponseForSharing: 'Error formatting response',
      };
    }
  }

  prepareValidMessages(
    historyMessages: any[],
    event: any,
    userMessage: string,
    cleanResponseForSharing: string,
  ): SlackMessage[] {
    // 히스토리 메시지를 validMessages 형식으로 변환
    const validMessages = (historyMessages || []).map((msg: any) => ({
      userId: msg.user || msg.bot_id || 'unknown',
      username: msg.username || (msg.bot_id ? 'CHOIR' : 'User'),
      text: msg.text,
      ts: msg.ts,
    }));

    // 현재 메시지가 포함되어 있는지 확인
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
      const tsA = Number.parseFloat(a.ts);
      const tsB = Number.parseFloat(b.ts);
      return tsB - tsA;
    });

    return validMessages;
  }

  async formatDocumentReferences(relevantDocs: any[], answerResult: any): Promise<string> {
    if (relevantDocs.length === 0 || !answerResult.canAnswer) {
      return '';
    }

    try {
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
              if (metadata.githubUrl && metadata.headingPath) {
                const headingString = Array.isArray(metadata.headingPath)
                  ? metadata.headingPath.join('-')
                  : metadata.headingPath;
                const headingAnchor = headingString
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

      return documentInfo.join('\n');
    } catch (error) {
      Logger.error('Error formatting document references', error as Error);
      return '';
    }
  }
}
