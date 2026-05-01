import { SessionType, getSessionData } from 'services/common';
import type { SlackMessage } from 'services/slack';

export interface SourceContext {
  knowledgeContent: string;
  sourceMessages: SlackMessage[];
  validMessages: SlackMessage[];
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
}

export async function loadSourceContext(
  parsedValue: any,
  userId: string,
  client: any,
  logger: any,
): Promise<SourceContext> {
  const sessionId = parsedValue.sessionId;
  let knowledgeContent: string = parsedValue.knowledgeContent || '';
  let sourceMessages: SlackMessage[] = [];
  let knowledgeSourceChannelId: string | undefined = parsedValue.originalChannelId;
  let knowledgeSourceThreadTs: string | undefined = parsedValue.originalThreadTs;

  if (!knowledgeContent && sessionId) {
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (sessionData?.extractedKnowledge) {
      knowledgeContent = sessionData.extractedKnowledge;
      logger.info(`Retrieved knowledgeContent from session data for sessionId: ${sessionId}`);
    }
  }

  if (parsedValue.action === 'keep' || parsedValue.action === 'skip') {
    if (sessionId) {
      const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
      if (sessionData?.extractedKnowledge) {
        knowledgeContent = sessionData.extractedKnowledge;
      } else {
        logger.warn(
          `Extracted knowledge not found in session data for session ${sessionId} when action is "${parsedValue.action}".`,
        );
      }
    } else {
      logger.error(`SessionId not found when action is '${parsedValue.action}'. Cannot retrieve knowledgeContent.`);
    }
  }

  if (sessionId) {
    try {
      const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;

      if (sessionData?.sourceMessages && sessionData.sourceMessages.length > 0) {
        sourceMessages = sessionData.sourceMessages.map((msg: any) => ({
          ...msg,
          username: msg.username || msg.user || 'Unknown User',
        }));
      } else if (sessionData?.messages && sessionData.messages.length > 0) {
        sourceMessages = sessionData.messages.map((msg: any) => ({
          ...msg,
          username: msg.username || msg.user || 'Unknown User',
        }));
      }

      if (!knowledgeSourceChannelId && sessionData?.originalChannelId)
        knowledgeSourceChannelId = sessionData.originalChannelId;
      if (!knowledgeSourceThreadTs && sessionData?.originalThreadTs)
        knowledgeSourceThreadTs = sessionData.originalThreadTs;
    } catch (error) {
      console.warn('Failed to get sourceMessages from sessionData:', error);
    }
  }

  if (sourceMessages.length === 0 && parsedValue.sourceMessages) {
    sourceMessages = parsedValue.sourceMessages.map((msg: any) => ({
      ...msg,
      username: msg.username || msg.user || 'Unknown User',
    }));
  }

  let validMessages: SlackMessage[];
  if (sourceMessages.length > 0) {
    validMessages = sourceMessages;
  } else {
    let actualUsername = 'User';
    try {
      const userInfo = await client.users.info({ user: userId });
      actualUsername = userInfo.user?.real_name || userInfo.user?.name || 'User';
    } catch (error) {
      console.warn('Failed to get username for fallback message:', error);
    }

    validMessages = [
      {
        userId,
        username: actualUsername,
        text: `Knowledge extracted: ${knowledgeContent}`,
        ts: Date.now().toString(),
      },
    ];
  }

  return { knowledgeContent, sourceMessages, validMessages, knowledgeSourceChannelId, knowledgeSourceThreadTs };
}
