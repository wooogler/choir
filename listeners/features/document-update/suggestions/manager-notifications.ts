import { getManagers, getWorkspaceId } from 'services/slack';

export async function notifyOtherManagersAboutUpdate(
  _currentUpdate: any,
  currentManagerId: string,
  updatedBy: string,
  notificationText: string,
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
        await client.chat.postMessage({
          channel: managerId,
          text: `📝 Document Update by ${updatedBy}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📝 *Document Update Notification*\n\n${updatedBy} has updated a document that you were also reviewing.`,
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: notificationText },
            },
            ...blocks.slice(1),
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

  const updatePromises = Object.entries(sessionData.managerMessageInfo)
    .filter(([managerId]) => managerId !== currentManagerId)
    .map(async ([managerId, messageInfo]: [string, any]) => {
      try {
        const blocks: any[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Hi! I'm CHOIR, your documentation assistant.\n*${sessionData.userName || 'A team member'}* has a document update suggestion:`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`${sessionData.extractedKnowledge || 'No content available'}\`\`\``,
            },
          },
        ];

        if (sessionData.originalMessageLink) {
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
            },
          });
        }

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Processing started by ${currentManagerName}*`,
          },
        });

        await client.chat.update({
          channel: messageInfo.channel,
          ts: messageInfo.ts,
          text: `✅ Processing started by ${currentManagerName}`,
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
    await client.chat.postMessage({
      channel: sessionData.originalChannelId,
      thread_ts: sessionData.originalThreadTs,
      text: `🔄 ${managerName} started processing your document update suggestion.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔄 *${managerName}* started processing your document update suggestion. You'll receive the document suggestions in your DM shortly! 📝`,
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
