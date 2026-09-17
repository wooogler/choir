import { getUserName } from 'services/slack';
import type { ManagerMessageRef, RegistrationRequestOrigin } from 'services/slack';
import { DEFAULT_LOCALE, type T, createT } from '../../../src/i18n';

export const REQUEST_ACCESS_ACTION_ID = 'request_choir_access';
export const APPROVE_REGISTRATION_ACTION_ID = 'approve_choir_registration';
export const DECLINE_REGISTRATION_ACTION_ID = 'decline_choir_registration';

/** A single mrkdwn section block. */
export function sectionBlock(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/**
 * Replaces the message that produced this interaction (the requester's own reply,
 * or a manager's DM) in place. response_url is scoped to the clicking user, so it
 * is only ever used for the actor's own message — other managers are synced via
 * chat.update against stored {channel, ts}. Best-effort; failure is non-fatal.
 */
export async function replaceOriginalMessage(body: any, text: string, logger: any): Promise<void> {
  const responseUrl = (body as any).response_url;
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_original: true, text, blocks: [sectionBlock(text)] }),
    });
  } catch (error) {
    logger.warn('Failed to update message via response_url:', error);
  }
}

/**
 * Rewrites every recorded manager DM to a final status line, removing the buttons
 * (by emitting only a section block). Optionally skips the acting manager, whose
 * own message is updated separately via response_url. Per-message failures are
 * isolated so one closed DM never aborts the rest.
 */
export async function updateAllManagerMessages(
  managerMessageInfo: Record<string, ManagerMessageRef> | undefined,
  client: any,
  logger: any,
  opts: { text: string; skipManagerId?: string },
): Promise<void> {
  if (!managerMessageInfo) return;
  await Promise.allSettled(
    Object.entries(managerMessageInfo)
      .filter(([managerId]) => managerId !== opts.skipManagerId)
      .map(async ([managerId, info]) => {
        if (!info?.ts || !info?.channel) return;
        try {
          await client.chat.update({
            channel: info.channel,
            ts: info.ts,
            text: opts.text,
            blocks: [sectionBlock(opts.text)],
          });
        } catch (error) {
          logger.warn(`Failed to update manager ${managerId} registration message:`, error);
        }
      }),
  );
}

/**
 * Blocks for a manager's "someone is requesting access" DM (approve/decline buttons).
 *
 * `t` is the *receiving manager's* translator, not the requester's — this card
 * is fanned out one DM per manager, so each copy is built with its own reader's
 * language. request-access-action passes one per manager; the English default
 * exists so the builder stays synchronous and renderable without a resolver
 * (tests, previews).
 */
export function buildManagerRequestBlocks(params: {
  userName: string;
  requesterUserId: string;
  origin: RegistrationRequestOrigin;
  consentFormUrl?: string;
  t?: T;
}): any[] {
  const { userName, requesterUserId, origin, consentFormUrl } = params;
  const t = params.t ?? createT(DEFAULT_LOCALE);

  const contextParts = [
    origin.isPublic
      ? t('registration.managerCard.origin.channel', { channelLink: `<#${origin.channelId}>` })
      : t('registration.managerCard.origin.dm'),
  ];
  if (consentFormUrl) {
    contextParts.push(
      t('registration.managerCard.consentReminder', {
        consentFormLink: `<${consentFormUrl}|${t('registration.link.consentForm')}>`,
      }),
    );
  }

  return [
    sectionBlock(t('registration.managerCard.request', { userName })),
    { type: 'context', elements: [{ type: 'mrkdwn', text: contextParts.join(' ') }] },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: t('registration.managerCard.approve.button'), emoji: true },
          style: 'primary',
          action_id: APPROVE_REGISTRATION_ACTION_ID,
          value: requesterUserId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: t('registration.managerCard.decline.button'), emoji: true },
          style: 'danger',
          action_id: DECLINE_REGISTRATION_ACTION_ID,
          value: requesterUserId,
        },
      ],
    },
  ];
}

/** "*Alice*, *Bob*" — bold display names for a set of manager user IDs. */
export async function buildManagerMentions(managers: string[], client: any): Promise<string> {
  const names = await Promise.all(managers.map(async (id) => `*${await getUserName(id, client)}*`));
  return names.join(', ');
}
