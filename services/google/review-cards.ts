import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { tForUser } from 'services/i18n';
import { getAllDocStates, getDocState, mutateDocState } from './gdocs-state';
import type { GdocsRetireNotice } from './types';

/**
 * Retires review cards whose decision can no longer be carried out.
 *
 * A card is a live button in someone's DM. Unlinking a document or
 * disconnecting the account leaves managers looking at an Approve they can
 * click: the decision would fail, or worse succeed against a mapping that no
 * longer exists. Replacing the card's text removes the buttons with it.
 *
 * The replacement is written once per card rather than once per call: the
 * reason arrives as a catalog key, and the card knows whose DM it is sitting
 * in, so each manager is told in their own language.
 */
export async function retireReviewCards(params: {
  workspaceId: string;
  githubPath: string;
  notice: GdocsRetireNotice;
  client?: WebClient;
}): Promise<void> {
  const state = await getDocState(params.workspaceId, params.githubPath);
  const cards = state?.reviewCards ?? [];
  if (cards.length === 0) return;

  if (params.client) {
    await Promise.allSettled(
      cards.map(async (card) => {
        try {
          const t = await tForUser(params.workspaceId, card.managerId, params.client);
          const text = t(params.notice.reason, params.notice.params);
          await params.client?.chat.update({
            channel: card.channel,
            ts: card.ts,
            text,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] as never,
          });
        } catch (error) {
          Logger.warn('Could not retire a Google Docs review card', {
            workspaceId: params.workspaceId,
            managerId: card.managerId,
            error: (error as Error).message,
          });
        }
      }),
    );
  }

  // Clear the refs even when Slack was unreachable: the buttons are dead either
  // way, and a later drift should post fresh cards rather than try to update
  // messages that describe a mapping that is gone.
  await mutateDocState(params.workspaceId, params.githubPath, (current) =>
    current ? { ...current, reviewCards: undefined, updatedAt: '' } : null,
  );
}

/** Retires every outstanding card in a workspace, for disconnect. */
export async function retireAllReviewCards(params: {
  workspaceId: string;
  notice: GdocsRetireNotice;
  client?: WebClient;
}): Promise<void> {
  const states = await getAllDocStates(params.workspaceId);
  for (const [githubPath, state] of Object.entries(states)) {
    if (!state.reviewCards?.length) continue;
    await retireReviewCards({ ...params, githubPath });
  }
}
