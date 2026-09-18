/**
 * The App Home tab bar. One regex listener covers all four buttons, because
 * `action_id`s have to be unique inside a block — `home_tab:<tab>` rather than
 * one id carrying the tab as a value.
 *
 * Hiding the manager tabs from a member is layout, not enforcement: anyone can
 * replay a block action. So the requested tab is checked against the actor's
 * rights here and quietly downgraded to Home when they do not hold them — there
 * is nothing to warn about, they simply get the tab they are allowed to see.
 */

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { type HomeTab, isHomeTab, isManagerOnlyTab, setActiveTab } from '../home-tabs';
import { refreshAppHome } from '../refresh';
import { logManagementButtonError } from './shared';

const TAB_ACTION_PREFIX = 'home_tab:';
const ACTION_LABEL = 'Switch Home Tab';

export const registerTabHandlers = (app: App) => {
  app.action<BlockAction<ButtonAction>>(/^home_tab:/, async ({ ack, action, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    const userId = body.user.id;
    const actionId = action.action_id;

    try {
      const requested = actionId.slice(TAB_ACTION_PREFIX.length);
      const workspaceId = await getWorkspaceId(client);
      const [isUserManager, isOwner] = await Promise.all([
        isManager(workspaceId, userId),
        isWorkspaceOwner(userId, client),
      ]);
      const canManage = isUserManager || isOwner;

      const tab: HomeTab = isHomeTab(requested) && (canManage || !isManagerOnlyTab(requested)) ? requested : 'home';

      setActiveTab(workspaceId, userId, tab);

      // Immediate, not `Soon`: nothing is closing over this one, and a tab that
      // takes a second to switch feels broken.
      await refreshAppHome({ client, logger, userId, reason: 'tab switch' });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        actionId,
        Date.now() - startTime,
        true,
        ACTION_LABEL,
        { requested, tab },
        client,
      );
    } catch (error) {
      logger.error('Error switching App Home tab:', error);
      await logManagementButtonError({
        userId,
        actionId,
        actionLabel: ACTION_LABEL,
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
