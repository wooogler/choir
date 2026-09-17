import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { tForRequest, tForUser, tForWorkspace } from 'services/i18n';
import { getRegistrationRequest, getUserName, getWorkspaceId, saveRegistrationRequest } from 'services/slack';
import { requireManagerForAction } from '../app-home/management/shared';
import { DECLINE_REGISTRATION_ACTION_ID, replaceOriginalMessage, updateAllManagerMessages } from './shared';

/**
 * "Decline" button (manager only). Marks the request declined (discarding the held
 * question) and syncs every manager's card, then notifies the requester.
 */
export const declineChoirRegistrationAction = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // The deciding manager reads `t`; the other managers' cards are rewritten
  // once for all of them, and the requester is told in their own language.
  const t = tForRequest(context);

  try {
    const managerId = body.user.id;
    if (!(await requireManagerForAction({ client, userId: managerId }))) {
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const targetUserId = body.actions[0].value;
    if (!targetUserId) {
      logger.warn('Decline registration action missing target user id');
      return;
    }
    const request = getRegistrationRequest(workspaceId, targetUserId);

    if (!request || request.status !== 'pending') {
      await replaceOriginalMessage(body, t('registration.action.alreadyHandled'), logger);
      return;
    }

    const managerName = await getUserName(managerId, client);
    const targetName = request.userName || (await getUserName(targetUserId, client));

    // Keep the record (so a re-ask shows the "declined" notice) but discard the
    // held question — a declined user's message must not linger.
    request.status = 'declined';
    request.heldQuestion = undefined;
    saveRegistrationRequest(request);

    const tWorkspace = await tForWorkspace(workspaceId);
    await updateAllManagerMessages(request.managerMessageInfo, client, logger, {
      text: tWorkspace('registration.managerCard.declined', { targetName, managerName }),
      skipManagerId: managerId,
    });
    await replaceOriginalMessage(body, t('registration.decline.confirmation', { targetName }), logger);

    try {
      const opened = await client.conversations.open({ users: targetUserId });
      const dmChannel = opened.channel?.id;
      if (dmChannel) {
        const tRequester = await tForUser(workspaceId, targetUserId, client);
        await client.chat.postMessage({
          channel: dmChannel,
          text: tRequester('registration.decline.notice'),
        });
      }
    } catch (error) {
      logger.warn('Failed to notify declined user:', error);
    }

    await logButtonClick(
      managerId,
      workspaceId,
      managerId,
      'dm',
      DECLINE_REGISTRATION_ACTION_ID,
      Date.now() - startTime,
      true,
      { targetUserId },
      client,
    );
  } catch (error) {
    logger.error('Error declining CHOIR registration:', error);
  }
};
