import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import {
  type ManualApplyButtonValue,
  confirmManualApply,
  declineManualApply,
  retireManualCards,
} from 'services/google/manual-apply';
import { tForRequest } from 'services/i18n';
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
  context,
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

    // The clicker's own copy of the card; the other managers' copies are
    // retired in their own languages by `retireManualCards`.
    const t = tForRequest(context);
    const workspaceId = await getWorkspaceId(client);
    const outcome = await confirmManualApply({ workspaceId, githubPath: target.githubPath });

    if (outcome === 'applied') {
      await retireManualCards({
        workspaceId,
        githubPath: target.githubPath,
        notice: {
          reason: 'gdocs.card.retired.applied',
          params: { path: target.githubPath, manager: `<@${managerId}>` },
        },
        client,
      });
      await replaceOriginalMessage(body, t('gdocs.manual.reply.applied', { path: target.githubPath }), logger);
      return;
    }

    if (outcome === 'still-differs') {
      // Deliberately leaves the card in place: the work is not done, and
      // clearing the request here would lose the only reminder anyone has.
      await replaceOriginalMessage(body, t('gdocs.manual.reply.stillDiffers', { path: target.githubPath }), logger);
      return;
    }

    if (outcome === 'nothing-pending') {
      await replaceOriginalMessage(body, t('gdocs.manual.reply.alreadyHandled'), logger);
      return;
    }

    await replaceOriginalMessage(
      body,
      t('gdocs.manual.reply.checkFailed', { path: target.githubPath, outcome }),
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
  context,
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

    const t = tForRequest(context);
    const workspaceId = await getWorkspaceId(client);
    const declined = await declineManualApply({ workspaceId, githubPath: target.githubPath });

    if (!declined) {
      await replaceOriginalMessage(body, t('gdocs.manual.reply.alreadyHandled'), logger);
      return;
    }

    await retireManualCards({
      workspaceId,
      githubPath: target.githubPath,
      notice: {
        reason: 'gdocs.card.retired.declined',
        params: { path: target.githubPath, manager: `<@${managerId}>` },
      },
      client,
    });
    await replaceOriginalMessage(body, t('gdocs.manual.reply.declined', { path: target.githubPath }), logger);
  } catch (error) {
    logger.error('Google Docs manual-decline action failed', error);
  }
};
