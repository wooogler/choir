import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import {
  type ManualApplyButtonValue,
  confirmManualApply,
  declineManualApply,
  retireManualCards,
} from 'services/google/manual-apply';
import { getWorkspaceId } from 'services/slack';
import { requireManagerForAction } from '../app-home/management/shared';
import { replaceOriginalMessage } from '../registration/shared';

/**
 * The two buttons on a "this change has to be applied by hand" card.
 *
 * Both are manager-only, and both are checked rather than trusted: the applied
 * button re-reads the Google Doc before accepting the claim, because clearing
 * the request on the strength of a click would leave the recorded baseline
 * describing text the document does not hold, and the next poll would report
 * that difference as a fresh human edit.
 */

function readTarget(body: BlockButtonAction): ManualApplyButtonValue | null {
  const raw = body.actions[0]?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ManualApplyButtonValue;
    return typeof parsed?.githubPath === 'string' && parsed.githubPath.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export const gdocsManualAppliedAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const managerId = body.user.id;
    if (!(await requireManagerForAction({ client, userId: managerId }))) {
      return;
    }

    const target = readTarget(body);
    if (!target) {
      logger.warn('Google Docs manual-apply action arrived without a document');
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const outcome = await confirmManualApply({ workspaceId, githubPath: target.githubPath });

    if (outcome === 'applied') {
      await retireManualCards({
        workspaceId,
        githubPath: target.githubPath,
        reason: `✅ ${target.githubPath} — applied in Google Docs by <@${managerId}>.`,
        client,
      });
      await replaceOriginalMessage(
        body,
        `✅ ${target.githubPath} — thanks, the Doc and the repository agree now.`,
        logger,
      );
      return;
    }

    if (outcome === 'still-differs') {
      // Deliberately leaves the card in place: the work is not done, and
      // clearing the request here would lose the only reminder anyone has.
      await replaceOriginalMessage(
        body,
        `⚠️ ${target.githubPath} — the Google Doc still differs from the repository. Apply the change and press the button again.`,
        logger,
      );
      return;
    }

    if (outcome === 'nothing-pending') {
      await replaceOriginalMessage(body, 'ℹ️ This was already handled.', logger);
      return;
    }

    await replaceOriginalMessage(
      body,
      `⚠️ ${target.githubPath} — could not check the Google Doc (${outcome}). Try again shortly.`,
      logger,
    );
  } catch (error) {
    logger.error('Google Docs manual-apply action failed', error);
  }
};

export const gdocsManualDeclinedAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const managerId = body.user.id;
    if (!(await requireManagerForAction({ client, userId: managerId }))) {
      return;
    }

    const target = readTarget(body);
    if (!target) {
      logger.warn('Google Docs manual-decline action arrived without a document');
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const declined = await declineManualApply({ workspaceId, githubPath: target.githubPath });

    if (!declined) {
      await replaceOriginalMessage(body, 'ℹ️ This was already handled.', logger);
      return;
    }

    await retireManualCards({
      workspaceId,
      githubPath: target.githubPath,
      reason: `↩️ ${target.githubPath} — left as it is in Google Docs by <@${managerId}>. The repository keeps the change.`,
      client,
    });
    await replaceOriginalMessage(
      body,
      `↩️ ${target.githubPath} — left as it is. The Doc and the repository will differ until somebody changes one of them.`,
      logger,
    );
  } catch (error) {
    logger.error('Google Docs manual-decline action failed', error);
  }
};
