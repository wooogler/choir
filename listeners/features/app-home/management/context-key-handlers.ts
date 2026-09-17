import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { logManagementModalError, refreshAppHomeSoon, requireManagerForAction } from './shared';

// Type-to-confirm phrases for the destructive flows. Rotating/importing discards
// the ability to read all previously recorded change history, so we make the
// manager type an exact word rather than rely on a single click.
const ROTATE_PHRASE = 'ROTATE';
const IMPORT_PHRASE = 'IMPORT';

export const registerContextKeyHandlers = (app: App) => {
  // --- Rotate: warning + type-to-confirm ------------------------------------
  app.action('rotate_context_key', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();
    const t = tForRequest(context);
    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) return;
      const workspaceId = await getWorkspaceId(client);

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'rotate_context_key_modal',
          private_metadata: JSON.stringify({ workspaceId }),
          title: { type: 'plain_text', text: t('appHome.management.contextKey.rotate.title') },
          submit: { type: 'plain_text', text: t('appHome.management.contextKey.rotate.submit') },
          close: { type: 'plain_text', text: t('common.button.cancel') },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.contextKey.rotate.warning'),
              },
            },
            {
              type: 'input',
              block_id: 'confirm_block',
              label: {
                type: 'plain_text',
                text: t('appHome.management.contextKey.confirm.label', { phrase: ROTATE_PHRASE }),
              },
              element: {
                type: 'plain_text_input',
                action_id: 'confirm_input',
                placeholder: { type: 'plain_text', text: ROTATE_PHRASE },
              },
            },
          ],
        },
      });

      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'rotate_context_key',
        Date.now() - startTime,
        true,
        'Rotate provenance key',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error opening rotate-context-key modal:', error);
    }
  });

  app.view('rotate_context_key_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const t = tForRequest(context);
    const { workspaceId } = JSON.parse(view.private_metadata || '{}') as { workspaceId?: string };
    let acked = false;

    try {
      if (!(await requireManagerForAction({ client, userId, t }))) {
        await ack();
        return;
      }

      const typed = view.state.values.confirm_block?.confirm_input?.value?.trim();
      if (typed !== ROTATE_PHRASE) {
        await ack({
          response_action: 'errors',
          errors: { confirm_block: t('appHome.management.contextKey.confirm.error', { phrase: ROTATE_PHRASE }) },
        });
        acked = true;
        return;
      }

      const ws = workspaceId || (await getWorkspaceId(client));
      await new WorkspaceStore().rotateContextKey(ws);

      await ack();
      acked = true;

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.management.contextKey.rotate.success'),
      });
      refreshAppHomeSoon({ client, logger, userId, reason: 'context key rotation' });

      await logAppHomeModalSubmit(
        userId,
        ws,
        'rotate_context_key_modal',
        Date.now() - startTime,
        true,
        'Key rotated',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error rotating context key:', error);
      if (!acked) {
        await ack({
          response_action: 'errors',
          errors: { confirm_block: t('appHome.management.contextKey.rotate.error.modal') },
        }).catch(() => {});
      } else {
        await client.chat
          .postEphemeral({
            user: userId,
            channel: userId,
            text: t('appHome.management.contextKey.rotate.error.postAck'),
          })
          .catch(() => {});
      }
      await logManagementModalError({
        userId,
        callbackId: 'rotate_context_key_modal',
        message: 'Context key rotation error',
        startTime,
        error,
        client,
        logger,
      });
    }
  });

  // --- Back up: display the current key for copying -------------------------
  app.action('backup_context_key', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();
    const t = tForRequest(context);
    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) return;
      const workspaceId = await getWorkspaceId(client);
      const key = await new WorkspaceStore().getContextEncryptionKey(workspaceId);

      if (!key) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.management.contextKey.backup.missing'),
        });
        return;
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'backup_context_key_modal',
          title: { type: 'plain_text', text: t('appHome.management.contextKey.backup.title') },
          close: { type: 'plain_text', text: t('appHome.management.contextKey.backup.close') },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.contextKey.backup.intro'),
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `\`\`\`${key.toString('base64')}\`\`\`` },
            },
          ],
        },
      });

      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'backup_context_key',
        Date.now() - startTime,
        true,
        'Back up provenance key',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error opening backup-context-key modal:', error);
    }
  });

  // --- Import: paste a key + type-to-confirm --------------------------------
  app.action('import_context_key', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();
    const t = tForRequest(context);
    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) return;
      const workspaceId = await getWorkspaceId(client);
      const configured = (await new WorkspaceStore().getContextKeyStatus(workspaceId)).configured;

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'import_context_key_modal',
          private_metadata: JSON.stringify({ workspaceId }),
          title: { type: 'plain_text', text: t('appHome.management.contextKey.import.title') },
          submit: { type: 'plain_text', text: t('appHome.management.contextKey.import.submit') },
          close: { type: 'plain_text', text: t('common.button.cancel') },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: configured
                  ? t('appHome.management.contextKey.import.warning.configured')
                  : t('appHome.management.contextKey.import.warning.new'),
              },
            },
            {
              type: 'input',
              block_id: 'key_block',
              label: { type: 'plain_text', text: t('appHome.management.contextKey.import.key.label') },
              element: {
                type: 'plain_text_input',
                action_id: 'key_input',
                placeholder: { type: 'plain_text', text: t('appHome.management.contextKey.import.key.placeholder') },
              },
            },
            {
              type: 'input',
              block_id: 'confirm_block',
              label: {
                type: 'plain_text',
                text: t('appHome.management.contextKey.confirm.label', { phrase: IMPORT_PHRASE }),
              },
              element: {
                type: 'plain_text_input',
                action_id: 'confirm_input',
                placeholder: { type: 'plain_text', text: IMPORT_PHRASE },
              },
            },
          ],
        },
      });

      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'import_context_key',
        Date.now() - startTime,
        true,
        'Import provenance key',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error opening import-context-key modal:', error);
    }
  });

  app.view('import_context_key_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const t = tForRequest(context);
    const { workspaceId } = JSON.parse(view.private_metadata || '{}') as { workspaceId?: string };
    let acked = false;

    try {
      if (!(await requireManagerForAction({ client, userId, t }))) {
        await ack();
        return;
      }

      const typed = view.state.values.confirm_block?.confirm_input?.value?.trim();
      const keyB64 = view.state.values.key_block?.key_input?.value?.trim() || '';

      if (typed !== IMPORT_PHRASE) {
        await ack({
          response_action: 'errors',
          errors: { confirm_block: t('appHome.management.contextKey.confirm.error', { phrase: IMPORT_PHRASE }) },
        });
        acked = true;
        return;
      }
      // Validate the key is a base64-encoded 32-byte value before touching state.
      const decoded = Buffer.from(keyB64, 'base64');
      if (!keyB64 || decoded.length !== 32) {
        await ack({
          response_action: 'errors',
          errors: { key_block: t('appHome.management.contextKey.import.error.invalidKey') },
        });
        acked = true;
        return;
      }

      const ws = workspaceId || (await getWorkspaceId(client));
      await new WorkspaceStore().rotateContextKey(ws, { importKeyBase64: keyB64 });

      await ack();
      acked = true;

      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.management.contextKey.import.success'),
      });
      refreshAppHomeSoon({ client, logger, userId, reason: 'context key import' });

      await logAppHomeModalSubmit(
        userId,
        ws,
        'import_context_key_modal',
        Date.now() - startTime,
        true,
        'Key imported',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error importing context key:', error);
      if (!acked) {
        await ack({
          response_action: 'errors',
          errors: { key_block: t('appHome.management.contextKey.import.error.modal') },
        }).catch(() => {});
      } else {
        await client.chat
          .postEphemeral({
            user: userId,
            channel: userId,
            text: t('appHome.management.contextKey.import.error.postAck'),
          })
          .catch(() => {});
      }
      await logManagementModalError({
        userId,
        callbackId: 'import_context_key_modal',
        message: 'Context key import error',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
