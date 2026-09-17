import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { getUserName } from 'services/slack';
import type { T } from '../../../../../src/i18n';
import { notifyOriginalChannel, updateOtherManagerMessages } from '../manager-notifications';
import { MANAGER_SESSION_EXPIRY } from '../shared';

/**
 * Releases a manager's processing claim on a suggestion session so another
 * manager can pick it up. Without this, cancelling/stopping a review left the
 * session marked 'processing' for its full 14-day TTL, blocking everyone else.
 * Only the claim holder may release it.
 */
export function releaseSessionClaim(sessionId: string | undefined, userId: string): void {
  if (!sessionId) return;
  const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
  if (!sessionData || sessionData.processingBy !== userId) return;
  sessionData.status = undefined;
  sessionData.processingBy = undefined;
  sessionData.processingManagerName = undefined;
  sessionData.processingAt = undefined;
  storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);
}

export async function runConcurrencyControl(params: {
  userId: string;
  currentDmChannelId: string | undefined;
  body: any;
  client: any;
  logger: any;
  /**
   * The clicking manager's translator. The conflict notice replaces the card in
   * *their* DM via response_url, so it is written for them, not for the manager
   * who got there first.
   */
  t: T;
}): Promise<boolean> {
  const { userId, currentDmChannelId, body, client, logger, t } = params;

  const value = body.actions?.[0]?.value;
  if (!value) return false;

  try {
    const parsedValue = JSON.parse(value);
    const sessionId = parsedValue.sessionId;

    if (
      !sessionId ||
      parsedValue.index ||
      parsedValue.action ||
      parsedValue.isFileBasedReview ||
      parsedValue.selectedFile
    ) {
      return false;
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) return false;

    if (sessionData.processingBy === userId) {
      logger.info(`Manager ${userId} is already processing session ${sessionId}, skipping concurrency check`);
      return false;
    }

    if (sessionData.status === 'processing') {
      const processingManagerName =
        sessionData.processingManagerName || t('docUpdate.suggestions.conflict.anotherManager');

      try {
        if (body.response_url) {
          const introBlock: any = {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('notifications.manager.suggestion.intro', {
                userName: sessionData.userName || t('notifications.manager.suggestion.anonymousUser'),
              }),
            },
          };

          if (sessionData.userId) {
            try {
              const userInfo = await client.users.info({ user: sessionData.userId });
              introBlock.accessory = {
                type: 'image',
                image_url:
                  userInfo.user?.profile?.image_192 || 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
                alt_text: sessionData.userName || t('docUpdate.suggestions.image.alt.profile'),
              };
            } catch {
              introBlock.accessory = {
                type: 'image',
                image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
                alt_text: sessionData.userName || t('docUpdate.suggestions.image.alt.profile'),
              };
            }
          }

          const originalBlocks: any[] = [
            introBlock,
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `\`\`\`${sessionData.extractedKnowledge || t('notifications.manager.suggestion.noContent')}\`\`\``,
              },
            },
          ];

          if (sessionData.originalMessageLink) {
            originalBlocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('notifications.manager.suggestion.context', {
                  discussionLink: `<${sessionData.originalMessageLink}|${t('notifications.link.viewDiscussion')}>`,
                }),
              },
            });
          }

          originalBlocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: t('docUpdate.suggestions.conflict.claimed', { managerName: processingManagerName }),
            },
          });

          await fetch(body.response_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              replace_original: true,
              text: t('docUpdate.suggestions.conflict.claimed.fallback', { managerName: processingManagerName }),
              blocks: originalBlocks,
            }),
          });
        }
      } catch (responseError) {
        logger.warn('Failed to send conflict message via response_url:', responseError);
      }

      logger.info(
        `Manager ${userId} tried to process session ${sessionId} but it's already being processed by ${sessionData.processingBy}`,
      );
      return true;
    }

    // Claim processing ATOMICALLY: write the claim before any await, so a second
    // manager's handler (which only runs when this one yields) sees the claim and
    // hits the conflict path above. Previously an `await getUserName` sat between
    // the status check and the store, letting two managers both claim.
    sessionData.status = 'processing';
    sessionData.processingBy = userId;
    sessionData.processingAt = new Date().toISOString();
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);

    // Now safe to do async work: resolve the display name and persist it.
    const managerName = await getUserName(userId, client);
    sessionData.processingManagerName = managerName;
    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE, MANAGER_SESSION_EXPIRY);

    logger.info(`Manager ${managerName} (${userId}) claimed processing for session ${sessionId}`);

    await updateOtherManagerMessages(sessionData, userId, managerName, client, logger);

    const isManagerOwnWork = sessionData.userId === userId;
    const isSameChannel = sessionData.originalChannelId === currentDmChannelId;
    const isThreadInteraction = !!sessionData.originalThreadTs;
    const shouldNotify = sessionData.originalChannelId && !isSameChannel && !isManagerOwnWork && !isThreadInteraction;

    logger.info(
      `[DEBUG] Notification check: originalChannelId=${sessionData.originalChannelId}, currentDmChannelId=${currentDmChannelId}, userId=${sessionData.userId}, managerId=${userId}, isManagerOwnWork=${isManagerOwnWork}, isSameChannel=${isSameChannel}, isThreadInteraction=${isThreadInteraction}, shouldNotify=${shouldNotify}`,
    );

    if (shouldNotify) {
      logger.info(`[DEBUG] Sending notification to original channel: ${sessionData.originalChannelId}`);
      await notifyOriginalChannel(sessionData, managerName, client, logger);
    } else if (isManagerOwnWork) {
      logger.info(`[DEBUG] Skipping notification - manager's own work`);
    } else if (isSameChannel) {
      logger.info('[DEBUG] Skipping notification - same channel');
    } else if (isThreadInteraction) {
      logger.info('[DEBUG] Skipping notification - thread interaction (notification handled via response_url)');
    }

    return false;
  } catch (error) {
    logger.warn('Error in concurrency control:', error);
    return false;
  }
}
