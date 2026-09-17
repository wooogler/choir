import { tForUser, tForWorkspace } from 'services/i18n';
import { getManagers, getWorkspaceId } from 'services/slack';

/**
 * Tells the managers who were not the one who applied the update.
 *
 * The caller has already written the same sentence once, for the source
 * channel, and it would be cheaper to forward that string — but it was written
 * in the *workspace's* language, and these are DMs to named people. So the
 * caller passes the pieces and each manager's line is rendered here, next to
 * the translator that belongs to them.
 */
export async function notifyOtherManagersAboutUpdate(
  _currentUpdate: any,
  currentManagerId: string,
  updatedBy: string,
  applied: { fileLink: string; sectionInfo: string },
  blocks: any[],
  client: any,
  logger: any,
): Promise<void> {
  try {
    const workspaceId = await getWorkspaceId(client);
    const managers = await getManagers(workspaceId);
    const otherManagers = managers.filter((managerId) => managerId !== currentManagerId);

    if (otherManagers.length === 0) {
      logger.info('No other managers to notify about update');
      return;
    }

    const notificationPromises = otherManagers.map(async (managerId) => {
      try {
        // One translator per recipient, not per message part: this DM is read by
        // `managerId`, not by the manager who made the update.
        const t = await tForUser(workspaceId, managerId, client);
        await client.chat.postMessage({
          channel: managerId,
          text: t('notifications.manager.update.fallback', { updatedBy }),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('notifications.manager.update.body', { updatedBy }),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('docUpdate.suggestions.applied.channel', { updatedBy, ...applied }),
              },
            },
            ...blocks,
          ],
          unfurl_links: false,
          unfurl_media: false,
        });
        logger.info(`Notified manager ${managerId} about document update by ${updatedBy}`);
      } catch (error) {
        logger.warn(`Failed to notify manager ${managerId} about update:`, error);
      }
    });

    await Promise.allSettled(notificationPromises);
    logger.info(`Update notification sent to ${otherManagers.length} other managers`);
  } catch (error) {
    logger.error('Error notifying other managers about update:', error);
  }
}

export async function updateOtherManagerMessages(
  sessionData: any,
  currentManagerId: string,
  currentManagerName: string,
  client: any,
  logger: any,
): Promise<void> {
  if (!sessionData.managerMessageInfo) {
    logger.warn('No managerMessageInfo found in session data');
    return;
  }

  const workspaceId = await getWorkspaceId(client);

  const updatePromises = Object.entries(sessionData.managerMessageInfo)
    .filter(([managerId]) => managerId !== currentManagerId)
    .map(async ([managerId, messageInfo]: [string, any]) => {
      try {
        // Rewriting a card that was sent to `managerId`, so it stays in the
        // language that card was written in — not the claiming manager's.
        const t = await tForUser(workspaceId, managerId, client);
        const blocks: any[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('notifications.manager.suggestion.intro', {
                userName: sessionData.userName || t('notifications.manager.suggestion.anonymousUser'),
              }),
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`${sessionData.extractedKnowledge || t('notifications.manager.suggestion.noContent')}\`\`\``,
            },
          },
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
            text: t('notifications.manager.suggestion.claimed', { managerName: currentManagerName }),
          },
        });

        await client.chat.update({
          channel: messageInfo.channel,
          ts: messageInfo.ts,
          text: t('notifications.manager.suggestion.claimed.fallback', { managerName: currentManagerName }),
          blocks,
        });
        logger.info(`Updated message for manager ${managerId} - processing started by ${currentManagerName}`);
      } catch (error) {
        logger.warn(`Failed to update message for manager ${managerId}:`, error);
      }
    });

  await Promise.allSettled(updatePromises);
}

export async function notifyOriginalChannel(
  sessionData: any,
  managerName: string,
  client: any,
  logger: any,
): Promise<void> {
  if (!sessionData.originalChannelId) {
    logger.warn('No originalChannelId found in session data - skipping channel notification');
    return;
  }

  try {
    // A post back into the channel the suggestion came from: everyone there
    // reads it, so it follows the workspace default rather than one person.
    const t = await tForWorkspace(await getWorkspaceId(client));
    await client.chat.postMessage({
      channel: sessionData.originalChannelId,
      thread_ts: sessionData.originalThreadTs,
      text: t('notifications.channel.processingStarted.fallback', { managerName }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('notifications.channel.processingStarted', { managerName }),
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    logger.info(`Notified original channel ${sessionData.originalChannelId} that ${managerName} started processing`);
  } catch (error) {
    logger.warn(`Failed to notify original channel ${sessionData.originalChannelId}:`, error);
  }
}
