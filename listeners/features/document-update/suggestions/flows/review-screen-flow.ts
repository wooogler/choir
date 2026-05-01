import { SessionType, getSessionData } from 'services/common';

export async function showReviewScreen(params: {
  sessionId: string;
  userId: string;
  currentDmChannelId: string;
  knowledgeContent: string;
  parsedValue: any;
  client: any;
  logger: any;
}): Promise<boolean> {
  const { sessionId, userId, currentDmChannelId, knowledgeContent, parsedValue, client, logger } = params;

  if (!sessionId || parsedValue.continueToFileSelection) return false;

  const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
  if (
    !sessionData?.originalChannelId ||
    sessionData.originalChannelId === currentDmChannelId ||
    sessionData.originalChannelId.startsWith('D')
  ) {
    return false;
  }

  logger.info(`Showing suggestion review for channel suggestion from ${sessionData.originalChannelId}`);

  const isManagerOwnSuggestion = sessionData.userId === userId;
  const userName = sessionData.userName || 'A team member';

  const introBlock: any = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: isManagerOwnSuggestion
        ? `Hi! I'm CHOIR, your documentation assistant.\n\nYou have a document update suggestion:`
        : `Hi! I'm CHOIR, your documentation assistant.\n\n*${userName}* has a document update suggestion:`,
    },
  };

  if (sessionData.userId && !isManagerOwnSuggestion) {
    try {
      const userInfo = await client.users.info({ user: sessionData.userId });
      introBlock.accessory = {
        type: 'image',
        image_url: userInfo.user?.profile?.image_192 || 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: userName || 'User profile',
      };
    } catch {
      introBlock.accessory = {
        type: 'image',
        image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: userName || 'User profile',
      };
    }
  }

  const blocks: any[] = [
    introBlock,
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${knowledgeContent}\`\`\`` } },
  ];

  if (sessionData.originalMessageLink) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context` },
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: isManagerOwnSuggestion
        ? 'Please review your suggestion above and choose how to proceed:'
        : 'You requested this document update suggestion. Please review the content above and choose how to proceed:',
    },
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ Edit Suggestion', emoji: true },
        action_id: 'open_knowledge_edit_manager_modal',
        value: sessionId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🚀 Start Update Process', emoji: true },
        style: 'primary',
        action_id: 'suggest_updates',
        value: JSON.stringify({
          sessionId,
          originalChannelId: sessionData.originalChannelId,
          originalThreadTs: sessionData.originalThreadTs,
          continueToFileSelection: true,
        }),
      },
    ],
  } as any);

  await client.chat.postMessage({
    channel: currentDmChannelId,
    text: `📝 Document update suggestion from *${userName}*`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  return true;
}
