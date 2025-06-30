import { SessionType, generateSessionId, storeSessionData } from 'services/common';
import { Logger } from 'services/common/logger';
import { getQAChannel } from 'services/slack';
import type { SlackMessage } from 'services/slack';

export class QASessionManager {
  async createQASession(
    historyUsers: Set<string>,
    validMessages: SlackMessage[],
    workspaceId: string,
    userMessage: string,
    cleanResponseForSharing: string,
    event: any,
    answerResult: any,
    client: any,
  ): Promise<{ sessionId: string; qaChannelId?: string; qaChannelName?: string }> {
    try {
      // Q&A 채널 정보 가져오기
      const qaChannelId = await getQAChannel(workspaceId, client);

      // Q&A 채널 표시용 형식 지정
      let qaChannelName = '';
      if (qaChannelId) {
        try {
          const channelInfo = await client.conversations.info({ channel: qaChannelId });
          qaChannelName = channelInfo.channel?.name || 'unknown';
        } catch (error) {
          Logger.warn(`Could not get Q&A channel name for ${qaChannelId}`, error as Error);
          qaChannelName = '';
        }
      }

      // 세션 ID 생성
      const sessionId = generateSessionId('consultation');

      // 세션 데이터 저장
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

      Logger.info('QA session created', {
        sessionId,
        workspaceId,
        qaChannelId,
        qaChannelName,
      });

      return { sessionId, qaChannelId, qaChannelName };
    } catch (error) {
      Logger.error('Error creating QA session', error as Error);
      throw error;
    }
  }

  createActionElements(qaChannelId?: string, qaChannelName?: string, sessionId?: string) {
    const actionElements = [];

    // Q&A 채널이 설정된 경우에만 Q&A 채널 버튼 추가
    if (qaChannelId && qaChannelName && sessionId) {
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
    if (sessionId) {
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
    }

    return actionElements;
  }

  getEphemeralText(answerResult: any): string {
    return answerResult.canAnswer
      ? '💬 Not satisfied with my answer? Want to discuss this further or get more insights?'
      : "💬 I couldn't find this information in our documentation. Would you like to ask others directly?";
  }
}
