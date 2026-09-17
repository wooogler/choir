/**
 * The two workspace-wide language settings on App Home: the default language
 * CHOIR speaks, and the language it writes document content in. Manager-gated
 * server-side, because hiding the select in the home view is not enforcement.
 */

import type { App } from '@slack/bolt';
import { logAppHomeButtonClick } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { type Locale, createT, isSupportedLocale } from '../../../../src/i18n';
import { logManagementButtonError, refreshAppHomeSoon, requireManagerForAction } from './shared';

const selectedValue = (body: unknown): string | undefined =>
  (body as any)?.actions?.[0]?.selected_option?.value as string | undefined;

/** A language's own name, plus the wording for the "no fixed language" policy. */
const optionLabel = (locale: Locale, value: string): string => {
  const t = createT(locale);
  if (value === 'follow-conversation') return t('appHome.language.option.followConversation');
  return t(value === 'ko' ? 'appHome.language.option.korean' : 'appHome.language.option.english');
};

export const registerLanguageHandlers = (app: App) => {
  app.action('set_workspace_language', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const userId = body.user.id;

    try {
      if (!(await requireManagerForAction({ client, userId }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const selected = selectedValue(body);
      const t = tForRequest(context);

      if (!isSupportedLocale(selected)) {
        logger.warn('Ignoring unsupported workspace language selection', { workspaceId, userId, selected });
        await client.chat.postEphemeral({ user: userId, channel: userId, text: t('common.error.generic') });
        return;
      }

      await new WorkspaceStore().setWorkspaceLanguage(workspaceId, selected);

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.language.confirm.workspace', { language: optionLabel(t.locale, selected) }),
      });

      refreshAppHomeSoon({ client, logger, userId, reason: 'workspace language change' });

      logger.info('Workspace language set', { workspaceId, userId, selected });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        'set_workspace_language',
        Date.now() - startTime,
        true,
        'Set Workspace Language',
        { selected },
        client,
      );
    } catch (error) {
      logger.error('Error setting workspace language:', error);
      await logManagementButtonError({
        userId,
        actionId: 'set_workspace_language',
        actionLabel: 'Set Workspace Language',
        startTime,
        error,
        client,
        logger,
      });
    }
  });

  app.action('set_content_language', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const userId = body.user.id;

    try {
      if (!(await requireManagerForAction({ client, userId }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const selected = selectedValue(body);
      const t = tForRequest(context);

      if (selected !== 'follow-conversation' && !isSupportedLocale(selected)) {
        logger.warn('Ignoring unsupported content language selection', { workspaceId, userId, selected });
        await client.chat.postEphemeral({ user: userId, channel: userId, text: t('common.error.generic') });
        return;
      }

      await new WorkspaceStore().setContentLanguage(workspaceId, selected);

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.language.confirm.content', { language: optionLabel(t.locale, selected) }),
      });

      refreshAppHomeSoon({ client, logger, userId, reason: 'content language change' });

      logger.info('Content language set', { workspaceId, userId, selected });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        'set_content_language',
        Date.now() - startTime,
        true,
        'Set Content Language',
        { selected },
        client,
      );
    } catch (error) {
      logger.error('Error setting content language:', error);
      await logManagementButtonError({
        userId,
        actionId: 'set_content_language',
        actionLabel: 'Set Content Language',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
