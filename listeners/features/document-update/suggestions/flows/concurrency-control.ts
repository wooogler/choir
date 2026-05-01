import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { getUserName } from 'services/slack';
import { notifyOriginalChannel, updateOtherManagerMessages } from '../manager-notifications';
import { MANAGER_SESSION_EXPIRY } from '../shared';

export async function runConcurrencyControl(params: {
  userId: string;
  currentDmChannelId: string | undefined;
  body: any;
  client: any;
  logger: any;
}): Promise<boolean> {
  const { userId, currentDmChannelId, body, client, logger } = params;

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
      const processingManagerName = sessionData.processingManagerName || 'Another manager';

      try {
        if (body.response_url) {
          const introBlock: any = {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Hi! I'm CHOIR, your documentation assistant.\n*${sessionData.userName || 'A team member'}* has a document update suggestion:`,
            },
          };

          if (sessionData.userId) {
            try {
              const userInfo = await client.users.info({ user: sessionData.userId });
              introBlock.accessory = {
                type: 'image',
                image_url:
                  userInfo.user?.profile?.image_192 || 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
                alt_text: sessionData.userName || 'User profile',
              };
            } catch {
              introBlock.accessory = {
                type: 'image',
                image_url: 'https://a.slack-edge.com/df10d/img/avatars/ava_0016-192.png',
                alt_text: sessionData.userName || 'User profile',
              };
            }
          }

          const originalBlocks: any[] = [
            introBlock,
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `\`\`\`${sessionData.extractedKnowledge || 'No content available'}\`\`\``,
              },
            },
          ];

          if (sessionData.originalMessageLink) {
            originalBlocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📍 <${sessionData.originalMessageLink}|View original discussion> for context`,
              },
            });
          }

          originalBlocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `❌ *Already being processed by ${processingManagerName}*` },
          });

          await fetch(body.response_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              replace_original: true,
              text: `❌ Already being processed by ${processingManagerName}`,
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

    // Claim processing
    const managerName = await getUserName(userId, client);
    sessionData.status = 'processing';
    sessionData.processingBy = userId;
    sessionData.processingManagerName = managerName;
    sessionData.processingAt = new Date().toISOString();
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
