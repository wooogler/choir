import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import {
  approveCHOIRUser,
  clearRegistrationRequest,
  getRegistrationRequest,
  getUserName,
  getWorkspaceId,
  isCHOIRUser,
} from 'services/slack';
import type { RegistrationRequest } from 'services/slack';
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
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

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
      await replaceOriginalMessage(body, 'ℹ️ This request was already handled.', logger);
      return;
    }

    // Atomic claim: deleting the row returns true only for the winning manager, so
    // the approval + auto-answer happens exactly once even on simultaneous clicks.
    if (!clearRegistrationRequest(workspaceId, targetUserId)) {
      await replaceOriginalMessage(body, 'ℹ️ Another manager just handled this request.', logger);
      return;
    }

    const managerName = await getUserName(managerId, client);
    const targetName = request.userName || (await getUserName(targetUserId, client));

    await approveCHOIRUser(workspaceId, targetUserId, client);

    await updateAllManagerMessages(request.managerMessageInfo, client, logger, {
      text: `✅ *${targetName}* — approved by *${managerName}*.`,
      skipManagerId: managerId,
    });
    await replaceOriginalMessage(body, `✅ *${targetName}* is now a CHOIR user.`, logger);

    await welcomeAndAnswer({ client, logger, targetUserId, request });

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
}): Promise<void> {
  const { client, logger, targetUserId, request } = params;

  let dmChannel: string | undefined;
  try {
    const opened = await client.conversations.open({ users: targetUserId });
    dmChannel = opened.channel?.id;
  } catch (error) {
    logger.error('Failed to open DM with approved user:', error);
  }
  if (!dmChannel) return;

  const welcome = request.heldQuestion
    ? "🎉 You're in! You can now ask me anything about the team's documentation.\n\nHere's the answer to the question you asked earlier:"
    : "🎉 You're in! You can now ask me anything about the team's documentation. Just send me a question anytime.";

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
        text: `You originally asked this in <#${request.origin.channelId}> — feel free to share the answer there.`,
      });
    } catch (error) {
      logger.warn('Failed to post origin-channel hint to approved user:', error);
    }
  }
}
