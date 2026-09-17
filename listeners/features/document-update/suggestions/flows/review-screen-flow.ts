import { SessionType, getSessionData } from 'services/common';
import type { T } from '../../../../../src/i18n';

export async function showReviewScreen(params: {
  sessionId: string;
  userId: string;
  currentDmChannelId: string;
  knowledgeContent: string;
  parsedValue: any;
  client: any;
  logger: any;
  /** The reviewing manager's translator: this screen is posted into their DM. */
  t: T;
}): Promise<boolean> {
  const { sessionId, userId, currentDmChannelId, knowledgeContent, parsedValue, client, logger, t } = params;

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
  const userName = sessionData.userName || t('notifications.manager.suggestion.anonymousUser');

  const introBlock: any = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: isManagerOwnSuggestion
        ? t('docUpdate.suggestions.review.intro.own')
        : t('docUpdate.suggestions.review.intro.other', { userName }),
    },
  };

  if (sessionData.userId && !isManagerOwnSuggestion) {
    try {
      const userInfo = await client.users.info({ user: sessionData.userId });
      introBlock.accessory = {
        type: 'image',
        image_url: userInfo.user?.profile?.image_192 || 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: userName || t('docUpdate.suggestions.image.alt.profile'),
      };
    } catch {
      introBlock.accessory = {
        type: 'image',
        image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
        alt_text: userName || t('docUpdate.suggestions.image.alt.profile'),
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
      text: {
        type: 'mrkdwn',
        text: t('notifications.manager.suggestion.context', {
          discussionLink: `<${sessionData.originalMessageLink}|${t('notifications.link.viewDiscussion')}>`,
        }),
      },
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: isManagerOwnSuggestion
        ? t('docUpdate.suggestions.review.prompt.own')
        : t('docUpdate.suggestions.review.prompt.other'),
    },
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: t('docUpdate.suggestions.button.editSuggestion'), emoji: true },
        action_id: 'open_knowledge_edit_manager_modal',
        value: sessionId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: t('docUpdate.suggestions.button.startProcess'), emoji: true },
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
    text: t('docUpdate.suggestions.review.fallback', { userName }),
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  return true;
}
