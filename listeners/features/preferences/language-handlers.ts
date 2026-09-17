/**
 * The per-user language picker on App Home. Ungated on purpose: this is the one
 * setting whose whole point is that any member can change it for themselves,
 * and it writes nothing but their own row.
 */

import type { App } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { resolveLocaleForUser, tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { type Locale, createT, isSupportedLocale } from '../../../src/i18n';
import { refreshAppHomeSoon } from '../app-home/refresh';

const ACTION_ID = 'set_my_language';
const ACTION_LABEL = 'Set My Language';

/** A language's own name, which is the same string in every catalog. */
const languageName = (locale: Locale): string =>
  createT(locale)(locale === 'ko' ? 'appHome.language.option.korean' : 'appHome.language.option.english');

export const registerLanguageHandlers = (app: App) => {
  app.action(ACTION_ID, async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const userId = body.user.id;

    try {
      const selected = (body as any).actions?.[0]?.selected_option?.value as string | undefined;
      const workspaceId = await getWorkspaceId(client);

      if (selected !== 'auto' && !isSupportedLocale(selected)) {
        logger.warn('Ignoring unsupported language selection', { workspaceId, userId, selected });
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: tForRequest(context)('common.error.generic'),
        });
        return;
      }

      const workspaceStore = new WorkspaceStore();
      await workspaceStore.setUserLanguage(workspaceId, userId, selected === 'auto' ? null : selected);

      // Confirm in the language they just picked — for `auto` that means asking
      // the resolver what "automatic" now works out to, *after* the clear.
      const effective = selected === 'auto' ? await resolveLocaleForUser(workspaceId, userId, client) : selected;
      const t = createT(effective);
      const language = languageName(effective);

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text:
          selected === 'auto'
            ? t('appHome.language.confirm.mineAuto', { language })
            : t('appHome.language.confirm.mine', { language }),
      });

      refreshAppHomeSoon({ client, logger, userId, reason: 'language preference change' });

      logger.info('User language preference set', { workspaceId, userId, selected, effective });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        ACTION_ID,
        Date.now() - startTime,
        true,
        ACTION_LABEL,
        { selected, effective },
        client,
      );
    } catch (error) {
      logger.error('Error setting user language preference:', error);

      try {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: tForRequest(context)('common.error.generic'),
        });
      } catch {
        // Best-effort notice; the failure is already logged.
      }
    }
  });
};
