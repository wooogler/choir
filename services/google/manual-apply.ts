import type { WebClient } from '@slack/web-api';
import { diffIndices } from 'node-diff3';
import { Logger } from 'services/common/logger';
import { tForUser } from 'services/i18n';
import { WorkspaceMirrorService } from 'services/workspace/mirror-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import type { T } from '../../src/i18n';
import { stripBanner } from './banner';
import { recipientsFor } from './drift-notifier';
import { exportDocMarkdown } from './drive-client';
import { extractImportable, sameAfterDialect } from './gdocs-delta';
import { contentHash, getAllDocStates, getDocState, mutateDocState } from './gdocs-state';
import { getWorkspaceClient } from './google-auth-service';
import { seedReplica } from './replica-publisher';
import type { GdocsRetireNotice, GdocsReviewCard } from './types';

/**
 * Asks a person to carry a repository change into a Google Doc CHOIR will not
 * write to.
 *
 * A `preserve` document keeps its own formatting, which means the publisher
 * cannot push a GitHub-side change into it. The change is not lost — it is
 * committed and it is recorded against the document as `pendingManual` — but
 * without this it would sit there with nobody told, and the document would drift
 * away from the repository quietly. That is the failure mode this exists to
 * prevent: divergence is acceptable, *silent* divergence is not.
 *
 * Cards are kept in `manualCards`, deliberately apart from `reviewCards`. A drift
 * notification refreshes every card it finds in `reviewCards` with its own
 * blocks; if the two shared a field, an edit made in the Doc would silently
 * overwrite the "apply this by hand" card sitting in the same DM.
 */

export const MANUAL_APPLIED_ACTION_ID = 'gdocs_manual_applied';
export const MANUAL_DECLINED_ACTION_ID = 'gdocs_manual_declined';

/** Slack refuses a section over 3000 characters; the fence needs room too. */
const MAX_DIFF_CHARS = 2200;

export interface ManualApplyButtonValue {
  githubPath: string;
}

/** Documents whose pending change nobody has been told about yet. */
export async function documentsAwaitingNotice(workspaceId: string): Promise<string[]> {
  const states = await getAllDocStates(workspaceId);
  return Object.entries(states)
    .filter(([, state]) => state.pendingManual && !state.pendingManual.declined && !state.manualCards?.length)
    .map(([githubPath]) => githubPath);
}

/**
 * A unified-ish diff of what the repository has that the document does not.
 *
 * Built from the two snapshots rather than from the recorded target hash, so the
 * card always describes the difference as it stands right now — the repository
 * may have moved again between the change being held and this being sent.
 */
export function buildDiffPreview(docSide: string, repositorySide: string, t: T): string {
  const before = docSide.split('\n');
  const after = repositorySide.split('\n');
  const lines: string[] = [];

  for (const hunk of diffIndices(before, after)) {
    const [removedStart, removedLength] = hunk.buffer1;
    lines.push(`@@ line ${removedStart + 1} @@`);
    for (const line of before.slice(removedStart, removedStart + removedLength)) {
      lines.push(`- ${line}`);
    }
    for (const line of hunk.buffer2Content ?? []) {
      lines.push(`+ ${line}`);
    }
  }

  if (lines.length === 0) return '';

  const body = lines.join('\n');
  return body.length > MAX_DIFF_CHARS
    ? `${body.slice(0, MAX_DIFF_CHARS)}\n${t('gdocs.card.manual.diffTruncated', { count: body.length - MAX_DIFF_CHARS })}`
    : body;
}

function buildBlocks(params: { githubPath: string; docUrl: string; diff: string; t: T }): unknown[] {
  const { t } = params;
  const fileName = params.githubPath.split('/').pop() || params.githubPath;
  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: t('gdocs.card.manual.headline', { file: fileName }) },
    },
  ];

  if (params.diff) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${params.diff}\n\`\`\`` } });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: t('gdocs.card.manual.note') }],
  });

  const value = JSON.stringify({ githubPath: params.githubPath } satisfies ManualApplyButtonValue);
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: t('gdocs.card.button.openDoc'), emoji: true },
        url: params.docUrl,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: t('gdocs.card.manual.button.applied'), emoji: true },
        style: 'primary',
        action_id: MANUAL_APPLIED_ACTION_ID,
        value,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: t('gdocs.card.manual.button.declined'), emoji: true },
        action_id: MANUAL_DECLINED_ACTION_ID,
        value,
      },
    ],
  });

  return blocks;
}

/** Posts the card to every manager who should see it and records the refs. */
export async function notifyManualApply(params: {
  workspaceId: string;
  githubPath: string;
  client: WebClient;
}): Promise<void> {
  const { workspaceId, githubPath, client } = params;
  const store = new WorkspaceStore();

  const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
  if (!mapping) return;

  const state = await getDocState(workspaceId, githubPath);
  if (!state?.pendingManual || state.pendingManual.declined) return;

  const [docSide, repositorySide] = await Promise.all([
    readDocSide(workspaceId, githubPath),
    WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath),
  ]);
  if (repositorySide === null) return;

  const cards: GdocsReviewCard[] = [];
  await Promise.allSettled(
    (await recipientsFor(workspaceId, githubPath)).map(async (managerId) => {
      try {
        // Built inside the loop: the diff's truncation note and every line of
        // the card are the recipient's language, not the workspace default's.
        const t = await tForUser(workspaceId, managerId, client);
        const diff = docSide === null ? '' : buildDiffPreview(docSide, repositorySide, t);
        const blocks = buildBlocks({ githubPath, docUrl: mapping.webViewLink, diff, t });
        const posted = await client.chat.postMessage({
          channel: managerId,
          text: t('gdocs.card.manual.fallback', { path: githubPath }),
          blocks: blocks as never,
          unfurl_links: false,
          unfurl_media: false,
        });
        cards.push({ managerId, channel: (posted.channel as string) ?? managerId, ts: posted.ts as string });
      } catch (error) {
        Logger.warn('Could not DM a manager about a manual Google Docs change', {
          workspaceId,
          managerId,
          error: (error as Error).message,
        });
      }
    }),
  );

  if (cards.length === 0) {
    // Leave manualCards unset so the next sweep tries again rather than assuming
    // everyone was told.
    Logger.error('Google Docs manual-apply request went unreported: every manager DM failed', undefined, {
      workspaceId,
      githubPath,
    });
    return;
  }

  await mutateDocState(workspaceId, githubPath, (current) =>
    current ? { ...current, manualCards: cards, updatedAt: '' } : null,
  );
}

/** The repository markdown equivalent of what the document currently holds. */
async function readDocSide(workspaceId: string, githubPath: string): Promise<string | null> {
  const store = new WorkspaceStore();
  const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
  if (!mapping) return null;

  const auth = await getWorkspaceClient(workspaceId);
  if (!auth) return null;

  try {
    const exported = await exportDocMarkdown(auth, mapping.fileId);
    return extractImportable(stripBanner(exported).body).markdown;
  } catch (error) {
    Logger.warn('Could not read a Google Doc while preparing a manual-apply card', {
      workspaceId,
      githubPath,
      error: (error as Error).message,
    });
    return null;
  }
}

export type ManualApplyOutcome =
  /** The document now matches the repository; the bookkeeping is caught up. */
  | 'applied'
  /** The document still differs, so the request stands. */
  | 'still-differs'
  | 'nothing-pending'
  | 'not-linked'
  | 'not-connected'
  | 'failed';

/**
 * Checks that the document really does hold the change before accepting the
 * claim, then rebaselines against it.
 *
 * Trusting the button alone would be worse than not offering it: the request
 * would be cleared, the recorded baseline would go on describing text the
 * document does not have, and the next poll would report the difference as if a
 * person had just typed it.
 */
export async function confirmManualApply(params: {
  workspaceId: string;
  githubPath: string;
}): Promise<ManualApplyOutcome> {
  const { workspaceId, githubPath } = params;

  const state = await getDocState(workspaceId, githubPath);
  if (!state?.pendingManual || state.pendingManual.declined) {
    return 'nothing-pending';
  }

  const store = new WorkspaceStore();
  const mapping = await store.getGoogleDocMapping(workspaceId, githubPath);
  if (!mapping) return 'not-linked';

  const auth = await getWorkspaceClient(workspaceId);
  if (!auth) return 'not-connected';

  try {
    const exported = await exportDocMarkdown(auth, mapping.fileId);
    const asRepository = extractImportable(stripBanner(exported).body).markdown;
    const repositorySide = await WorkspaceMirrorService.getInstance().readMirrorFile(workspaceId, githubPath);
    if (repositorySide === null) return 'failed';

    if (!sameAfterDialect(asRepository, repositorySide)) {
      return 'still-differs';
    }

    const seeded = await seedReplica({ workspaceId, githubPath, markdown: asRepository, baseline: exported });
    if (seeded.outcome !== 'seeded' && seeded.outcome !== 'seeded-drifted') {
      return 'failed';
    }

    await mutateDocState(workspaceId, githubPath, (current) =>
      current
        ? {
            ...current,
            pendingManual: undefined,
            // Records that the document holds the repository's text, so the next
            // publish of the same content is a no-op rather than a fresh card.
            lastPushedContentHash: contentHash(repositorySide),
            updatedAt: '',
          }
        : null,
    );
    return 'applied';
  } catch (error) {
    Logger.error('Confirming a manual Google Docs application failed', error as Error, { workspaceId, githubPath });
    return 'failed';
  }
}

/**
 * Records that somebody has decided to leave the document alone.
 *
 * The request is kept rather than deleted, with `declined` set, so the same
 * content does not produce a fresh card on the next sweep. A newer repository
 * change replaces it and asks again, which is right — that is a different
 * decision.
 */
export async function declineManualApply(params: { workspaceId: string; githubPath: string }): Promise<boolean> {
  const state = await getDocState(params.workspaceId, params.githubPath);
  if (!state?.pendingManual || state.pendingManual.declined) return false;

  await mutateDocState(params.workspaceId, params.githubPath, (current) =>
    current?.pendingManual
      ? { ...current, pendingManual: { ...current.pendingManual, declined: true }, updatedAt: '' }
      : (current ?? null),
  );
  return true;
}

/**
 * Rewrites every outstanding manual-apply card down to a status line, which is
 * what removes its buttons, and forgets the refs.
 *
 * The refs are cleared even when Slack was unreachable: the buttons are dead
 * either way, and a later request should post fresh cards rather than try to
 * update messages describing a document that is no longer linked.
 */
export async function retireManualCards(params: {
  workspaceId: string;
  githubPath: string;
  notice: GdocsRetireNotice;
  client?: WebClient;
}): Promise<void> {
  const state = await getDocState(params.workspaceId, params.githubPath);
  const cards = state?.manualCards ?? [];
  if (cards.length === 0) return;

  if (params.client) {
    await Promise.allSettled(
      cards.map(async (card) => {
        try {
          // Per recipient, not per call: the manager who clicked "I applied it"
          // is rarely the only one holding a copy of this card.
          const t = await tForUser(params.workspaceId, card.managerId, params.client);
          const text = t(params.notice.reason, params.notice.params);
          await params.client?.chat.update({
            channel: card.channel,
            ts: card.ts,
            text,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] as never,
          });
        } catch (error) {
          Logger.warn('Could not retire a Google Docs manual-apply card', {
            workspaceId: params.workspaceId,
            managerId: card.managerId,
            error: (error as Error).message,
          });
        }
      }),
    );
  }

  await mutateDocState(params.workspaceId, params.githubPath, (current) =>
    current ? { ...current, manualCards: undefined, updatedAt: '' } : null,
  );
}

/** Retires every outstanding manual-apply card in a workspace, for disconnect. */
export async function retireAllManualCards(params: {
  workspaceId: string;
  notice: GdocsRetireNotice;
  client?: WebClient;
}): Promise<void> {
  const states = await getAllDocStates(params.workspaceId);
  for (const [githubPath, state] of Object.entries(states)) {
    if (!state.manualCards?.length) continue;
    await retireManualCards({ ...params, githubPath });
  }
}
