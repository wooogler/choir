import { tForUser } from 'services/i18n';
import { buildNonUserResponse, getRegistrationRequest, getUserName, saveRegistrationRequest } from 'services/slack';
import type { NonUserResponseState, RegistrationRequest } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { REQUEST_ACCESS_ACTION_ID } from './shared';

/**
 * Shared handling for a message from someone who is not (yet) a CHOIR user, used
 * by both the DM and mention handlers. Depending on where they are in the access
 * flow it shows a Request Access button (fresh), a "waiting" notice (pending), or
 * a "not approved" notice (declined). For a fresh contact it creates/refreshes an
 * "offered" request that holds their latest question, to be auto-answered on
 * approval. Mentions reply ephemerally so the notice isn't posted publicly.
 */
export async function handleNonUserAccess(params: {
  client: any;
  event: any;
  logger: any;
  userId: string;
  workspaceId: string;
  heldQuestion: string;
  isMention: boolean;
}): Promise<void> {
  const { client, event, logger, userId, workspaceId, heldQuestion, isMention } = params;

  const consentFormUrl = process.env.CHOIR_CONSENT_FORM_URL;
  const existing = getRegistrationRequest(workspaceId, userId);

  let state: NonUserResponseState;
  if (existing?.status === 'pending') {
    state = 'pending';
  } else if (existing?.status === 'declined') {
    state = 'declined';
  } else {
    state = 'fresh';
  }

  if (state === 'fresh') {
    // Create or refresh the offered request, holding the latest question. The
    // question is NOT sent to the LLM or logged until a manager approves.
    const userName = await getUserName(userId, client); // the only await before the write

    // Re-read right before the synchronous write: a "Request Access" click may
    // have claimed 'pending' while we resolved the name. If so, don't clobber it
    // back to 'offered' — honor the new state instead.
    const current = getRegistrationRequest(workspaceId, userId);
    if (current && current.status !== 'offered') {
      state = current.status === 'pending' ? 'pending' : 'declined';
    } else {
      const now = Date.now();
      const request: RegistrationRequest = {
        workspaceId,
        userId,
        userName,
        status: 'offered',
        heldQuestion: heldQuestion || undefined,
        origin: { channelId: event.channel, isPublic: isMention },
        managerMessageInfo: current?.managerMessageInfo ?? {},
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      saveRegistrationRequest(request);
    }
  }

  // This is CHOIR's first word to someone it has never seen, so the client is
  // handed over: their Slack locale has no chance of being cached yet, and the
  // one `users.info` it costs is on a path that is already awaiting Slack.
  const t = await tForUser(workspaceId, userId, client);

  const authorizationBlockId = createCHOIRBlockId(CHOIRMessageType.AUTHORIZATION);
  const { text, blocks } = await buildNonUserResponse(state, { authorizationBlockId, consentFormUrl, t });

  const finalBlocks =
    state === 'fresh'
      ? [
          ...blocks,
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: t('registration.nonUser.request.button'), emoji: true },
                style: 'primary',
                action_id: REQUEST_ACCESS_ACTION_ID,
                value: userId,
              },
            ],
          },
        ]
      : blocks;

  if (isMention) {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: userId,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      text,
      blocks: finalBlocks,
    });
  } else {
    await client.chat.postMessage({ channel: event.channel, text, blocks: finalBlocks });
  }

  logger.info(`Non-CHOIR user access handled (${state})`, { workspaceId, userId, channel: event.channel, isMention });
}
