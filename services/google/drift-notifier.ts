import { sanitizeText } from '@/utils';
import type { WebClient } from '@slack/web-api';
import { Logger } from 'services/common/logger';
import { getManagers, isManager } from 'services/slack/user-management';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import type { DriftResult } from './drift-detector';
import { getDocState, mutateDocState } from './gdocs-state';
import type { GdocsReviewCard } from './types';

/**
 * Tells managers that someone edited a Google Docs replica.
 *
 * There is no shared "DM the managers a card" helper in the codebase — the
 * registration flow and the document-update suggestions each roll their own — so
 * this follows the same shape: post per manager, remember {channel, ts} so the
 * cards can be updated later, and never let one closed DM abort the rest.
 *
 * Cards are posted once per drift, not once per poll. A document that stays
 * drifted reports `unchanged` on later sweeps (its version matches the recorded
 * review fence), and a further edit updates the existing cards rather than
 * stacking new ones.
 */

function viewerUrl(workspaceId: string, githubPath: string): string | null {
  const baseUrl = process.env.DOCS_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return null;
  const encoded = githubPath.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl}/docs/${encodeURIComponent(workspaceId)}/${encoded}?gdocsReview=1`;
}

function buildBlocks(params: {
  githubPath: string;
  docUrl: string;
  reviewUrl: string | null;
  editor?: string;
  alsoChangedOnGithub: boolean;
}): unknown[] {
  const fileName = params.githubPath.split('/').pop() || params.githubPath;
  const context = [
    // The editor is a Google display name we do not control; unescaped it can
    // inject links and formatting into a manager's DM.
    params.editor
      ? `Last edited by ${sanitizeText(params.editor).slice(0, 120)}.`
      : 'The editor could not be identified.',
    'The replica will not be overwritten until this is resolved.',
  ];
  if (params.alsoChangedOnGithub) {
    context.push('The GitHub side has also changed since the replica was published.');
  }

  const actions: Array<Record<string, unknown>> = [
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Open Google Doc', emoji: true },
      url: params.docUrl,
    },
  ];
  if (params.reviewUrl) {
    actions.unshift({
      type: 'button',
      text: { type: 'plain_text', text: 'Review changes', emoji: true },
      style: 'primary',
      url: params.reviewUrl,
    });
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `✏️ *${fileName}* was edited in Google Docs.` },
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context.join(' ') }] },
    { type: 'actions', elements: actions },
  ];
}

export async function recipientsFor(workspaceId: string, githubPath: string): Promise<string[]> {
  const store = new WorkspaceStore();
  const [mapping, auth] = await Promise.all([
    store.getGoogleDocMapping(workspaceId, githubPath),
    store.getGoogleAuth(workspaceId),
  ]);

  const recipients = new Set<string>();
  if (mapping?.linkedBy) recipients.add(mapping.linkedBy);
  if (auth?.connectedBy) recipients.add(auth.connectedBy);

  // Whoever linked the document may since have been demoted, and a review card
  // is an Approve button: only current managers should be handed one.
  const current: string[] = [];
  for (const userId of recipients) {
    if (await isManager(workspaceId, userId)) current.push(userId);
  }

  // They could all have left; falling back keeps the edit from sitting unseen.
  return current.length > 0 ? current : await getManagers(workspaceId);
}

export async function notifyDrift(params: {
  workspaceId: string;
  result: DriftResult;
  client: WebClient;
}): Promise<void> {
  const { workspaceId, result, client } = params;
  const store = new WorkspaceStore();

  const mapping = await store.getGoogleDocMapping(workspaceId, result.githubPath);
  if (!mapping) return;

  const state = await getDocState(workspaceId, result.githubPath);
  const blocks = buildBlocks({
    githubPath: result.githubPath,
    docUrl: mapping.webViewLink,
    reviewUrl: viewerUrl(workspaceId, result.githubPath),
    editor: result.lastModifyingUser,
    alsoChangedOnGithub: Boolean(
      state?.lastPushedContentHash && state.status === 'drifted' && result.outcome === 'drifted-again',
    ),
  });
  const fallback = `${result.githubPath} was edited in Google Docs.`;

  // A further edit during review refreshes what managers are already looking at.
  if (state?.reviewCards?.length) {
    await Promise.allSettled(
      state.reviewCards.map(async (card) => {
        try {
          await client.chat.update({ channel: card.channel, ts: card.ts, text: fallback, blocks: blocks as never });
        } catch (error) {
          Logger.warn('Could not refresh a Google Docs review card', {
            workspaceId,
            managerId: card.managerId,
            error: (error as Error).message,
          });
        }
      }),
    );
    return;
  }

  const cards: GdocsReviewCard[] = [];
  await Promise.allSettled(
    (await recipientsFor(workspaceId, result.githubPath)).map(async (managerId) => {
      try {
        const posted = await client.chat.postMessage({
          channel: managerId,
          text: fallback,
          blocks: blocks as never,
          unfurl_links: false,
          unfurl_media: false,
        });
        cards.push({ managerId, channel: (posted.channel as string) ?? managerId, ts: posted.ts as string });
      } catch (error) {
        Logger.warn('Could not DM a manager about a Google Docs edit', {
          workspaceId,
          managerId,
          error: (error as Error).message,
        });
      }
    }),
  );

  if (cards.length === 0) {
    // Leave reviewCards unset so the next detected change tries again rather
    // than silently assuming everyone was told.
    Logger.error('Google Docs drift went unreported: every manager DM failed', undefined, {
      workspaceId,
      githubPath: result.githubPath,
    });
    return;
  }

  await mutateDocState(workspaceId, result.githubPath, (current) => ({
    ...(current ?? { status: 'drifted', updatedAt: '' }),
    status: current?.status ?? 'drifted',
    reviewCards: cards,
    updatedAt: '',
  }));
}
