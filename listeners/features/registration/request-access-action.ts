import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { tForRequest, tForUser } from 'services/i18n';
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
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // Everything replaced via response_url is read by the requester, who is the
  // one clicking; the manager cards below are read by someone else entirely and
  // are built one translator at a time.
  const t = tForRequest(context);

  try {
    const workspaceId = await getWorkspaceId(client);
    const userId = body.user.id;
    const request = getRegistrationRequest(workspaceId, userId);

    // Only an offered request can be sent. Anything else means it was already
    // sent, already decided, or expired.
    if (!request || request.status !== 'offered') {
      if (request?.status === 'pending') {
        await replaceOriginalMessage(body, t('registration.request.alreadyPending'), logger);
      } else {
        await replaceOriginalMessage(body, t('registration.request.expired'), logger);
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
      await replaceOriginalMessage(body, t('registration.request.noManagers'), logger);
      return;
    }

    const consentFormUrl = process.env.CHOIR_CONSENT_FORM_URL;
    const managerMessageInfo: Record<string, { channel: string; ts: string }> = {};

    await Promise.allSettled(
      managers.map(async (managerId) => {
        try {
          // One card per manager, each in that manager's own language.
          const tManager = await tForUser(workspaceId, managerId, client);
          const posted = await client.chat.postMessage({
            channel: managerId,
            text: tManager('registration.managerCard.request.fallback', { userName: request.userName }),
            blocks: buildManagerRequestBlocks({
              userName: request.userName,
              requesterUserId: userId,
              origin: request.origin,
              consentFormUrl,
              t: tManager,
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
      await replaceOriginalMessage(body, t('registration.request.managersUnreachable'), logger);
      return;
    }

    request.managerMessageInfo = managerMessageInfo;
    saveRegistrationRequest(request);

    const mentions = await buildManagerMentions(managers, client);
    await replaceOriginalMessage(body, t('registration.request.sent', { managers: mentions }), logger);

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
