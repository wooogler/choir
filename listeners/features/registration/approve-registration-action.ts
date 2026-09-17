import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { tForRequest, tForUser, tForWorkspace } from 'services/i18n';
import {
  approveCHOIRUser,
  clearRegistrationRequest,
  getRegistrationRequest,
  getUserName,
  getWorkspaceId,
  isCHOIRUser,
} from 'services/slack';
import type { RegistrationRequest } from 'services/slack';
import type { T } from '../../../src/i18n';
import { requireManagerForAction } from '../app-home/management/shared';
import { handleQuestionMessage } from '../qa/question-handler';
import {
  APPROVE_REGISTRATION_ACTION_ID,
  replaceOriginalMessage,
  sectionBlock,
  updateAllManagerMessages,
} from './shared';

/**
 * "Approve" button (manager only). Registers the requester as a CHOIR user, syncs
 * every manager's card to an approved state, and auto-answers the question they
 * originally asked.
 */
export const approveChoirRegistrationAction = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // Three readers, three translators: the deciding manager sees `t`, the other
  // managers share one rewritten card (so it follows the workspace), and the
  // requester's DM is built from their own locale further down.
  const t = tForRequest(context);

  try {
    const managerId = body.user.id;
    if (!(await requireManagerForAction({ client, userId: managerId }))) {
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const targetUserId = body.actions[0].value;
    if (!targetUserId) {
      logger.warn('Approve registration action missing target user id');
      return;
    }
    const request = getRegistrationRequest(workspaceId, targetUserId);

    // Already handled if the request is gone, no longer pending, or the user is
    // already registered.
    if (!request || request.status !== 'pending' || (await isCHOIRUser(workspaceId, targetUserId))) {
      await replaceOriginalMessage(body, t('registration.action.alreadyHandled'), logger);
      return;
    }

    // Atomic claim: deleting the row returns true only for the winning manager, so
    // the approval + auto-answer happens exactly once even on simultaneous clicks.
    if (!clearRegistrationRequest(workspaceId, targetUserId)) {
      await replaceOriginalMessage(body, t('registration.action.claimedByOther'), logger);
      return;
    }

    const managerName = await getUserName(managerId, client);
    const targetName = request.userName || (await getUserName(targetUserId, client));

    await approveCHOIRUser(workspaceId, targetUserId, client);

    // One text for every remaining manager card, so no single reader's language
    // can claim it: the workspace default is the only defensible choice.
    const tWorkspace = await tForWorkspace(workspaceId);
    await updateAllManagerMessages(request.managerMessageInfo, client, logger, {
      text: tWorkspace('registration.managerCard.approved', { targetName, managerName }),
      skipManagerId: managerId,
    });
    await replaceOriginalMessage(body, t('registration.approve.confirmation', { targetName }), logger);

    await welcomeAndAnswer({
      client,
      logger,
      targetUserId,
      request,
      t: await tForUser(workspaceId, targetUserId, client),
    });

    await logButtonClick(
      managerId,
      workspaceId,
      managerId,
      'dm',
      APPROVE_REGISTRATION_ACTION_ID,
      Date.now() - startTime,
      true,
      { targetUserId },
      client,
    );
  } catch (error) {
    logger.error('Error approving CHOIR registration:', error);
  }
};

/**
 * DMs the newly approved user a welcome and, if they had a held question, answers
 * it through the normal Q&A path (references + share banner). Opening the IM first
 * gives a real channel id so the share banner's ephemeral post resolves.
 */
async function welcomeAndAnswer(params: {
  client: any;
  logger: any;
  targetUserId: string;
  request: RegistrationRequest;
  /** The *approved user's* translator — this whole function writes to them. */
  t: T;
}): Promise<void> {
  const { client, logger, targetUserId, request, t } = params;

  let dmChannel: string | undefined;
  try {
    const opened = await client.conversations.open({ users: targetUserId });
    dmChannel = opened.channel?.id;
  } catch (error) {
    logger.error('Failed to open DM with approved user:', error);
  }
  if (!dmChannel) return;

  const welcome = request.heldQuestion
    ? t('registration.approve.welcome.withQuestion')
    : t('registration.approve.welcome');

  try {
    await client.chat.postMessage({ channel: dmChannel, text: welcome, blocks: [sectionBlock(welcome)] });
  } catch (error) {
    logger.warn('Failed to post welcome message to approved user:', error);
  }

  if (!request.heldQuestion) return;

  const syntheticEvent = {
    channel: dmChannel,
    user: targetUserId,
    ts: `${Date.now() / 1000}`,
    channel_type: 'im',
  };
  await handleQuestionMessage(client, syntheticEvent, request.heldQuestion, logger);

  if (request.origin.isPublic) {
    try {
      await client.chat.postMessage({
        channel: dmChannel,
        text: t('registration.approve.originChannelHint', { channelLink: `<#${request.origin.channelId}>` }),
      });
    } catch (error) {
      logger.warn('Failed to post origin-channel hint to approved user:', error);
    }
  }
}
