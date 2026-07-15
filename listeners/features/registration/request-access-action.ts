import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getManagers, getRegistrationRequest, getWorkspaceId, saveRegistrationRequest } from 'services/slack';
import {
  REQUEST_ACCESS_ACTION_ID,
  buildManagerMentions,
  buildManagerRequestBlocks,
  replaceOriginalMessage,
} from './shared';

/**
 * "Request Access" button (clicked by a non-CHOIR user). Promotes their offered
 * request to pending and DMs every manager an approve/decline card.
 */
export const requestChoirAccessAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const workspaceId = await getWorkspaceId(client);
    const userId = body.user.id;
    const request = getRegistrationRequest(workspaceId, userId);

    // Only an offered request can be sent. Anything else means it was already
    // sent, already decided, or expired.
    if (!request || request.status !== 'offered') {
      if (request?.status === 'pending') {
        await replaceOriginalMessage(body, '⏳ Your request is already waiting for manager approval.', logger);
      } else {
        await replaceOriginalMessage(body, 'Please ask me a question again to request access.', logger);
      }
      return;
    }

    // Claim the offered → pending transition now, before any await. The read
    // above and this write are both synchronous, so a rapid double-click (or a
    // concurrent message taking the "fresh" path) sees "pending" and backs off
    // instead of fanning out a second set of manager cards.
    request.status = 'pending';
    request.managerMessageInfo = {};
    saveRegistrationRequest(request);

    const managers = await getManagers(workspaceId);
    if (managers.length === 0) {
      request.status = 'offered'; // roll back so the button / re-ask still works
      saveRegistrationRequest(request);
      await replaceOriginalMessage(
        body,
        '⚠️ No managers are configured in this workspace yet. Please contact your Slack admin.',
        logger,
      );
      return;
    }

    const consentFormUrl = process.env.CHOIR_CONSENT_FORM_URL;
    const managerMessageInfo: Record<string, { channel: string; ts: string }> = {};

    await Promise.allSettled(
      managers.map(async (managerId) => {
        try {
          const posted = await client.chat.postMessage({
            channel: managerId,
            text: `${request.userName} is requesting access to CHOIR.`,
            blocks: buildManagerRequestBlocks({
              userName: request.userName,
              requesterUserId: userId,
              origin: request.origin,
              consentFormUrl,
            }),
            unfurl_links: false,
            unfurl_media: false,
          });
          managerMessageInfo[managerId] = { channel: (posted.channel as string) ?? managerId, ts: posted.ts as string };
        } catch (error) {
          logger.error(`Failed to DM manager ${managerId} about access request:`, error);
        }
      }),
    );

    // If every manager DM failed, don't leave the requester stranded as "pending"
    // with no card anyone can act on — roll back to offered and ask them to retry.
    if (Object.keys(managerMessageInfo).length === 0) {
      request.status = 'offered';
      saveRegistrationRequest(request);
      await replaceOriginalMessage(
        body,
        "⚠️ I couldn't reach any manager right now — please try asking again in a moment.",
        logger,
      );
      return;
    }

    request.managerMessageInfo = managerMessageInfo;
    saveRegistrationRequest(request);

    const mentions = await buildManagerMentions(managers, client);
    await replaceOriginalMessage(
      body,
      `✅ Request sent to ${mentions}. If approved, I'll answer your question right away.`,
      logger,
    );

    await logButtonClick(
      userId,
      workspaceId,
      request.origin.channelId,
      request.origin.isPublic ? 'public' : 'dm',
      REQUEST_ACCESS_ACTION_ID,
      Date.now() - startTime,
      true,
      { managersNotified: Object.keys(managerMessageInfo).length },
      client,
    );
  } catch (error) {
    logger.error('Error handling CHOIR access request:', error);
  }
};
