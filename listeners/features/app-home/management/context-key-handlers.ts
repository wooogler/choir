import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
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
  app.action('rotate_context_key', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();
    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) return;
      const workspaceId = await getWorkspaceId(client);

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'rotate_context_key_modal',
          private_metadata: JSON.stringify({ workspaceId }),
          title: { type: 'plain_text', text: 'Rotate Key' },
          submit: { type: 'plain_text', text: 'Rotate' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '⚠️ *This permanently destroys access to all existing change history.*\n\nEvery previously recorded update (its conversation, extracted knowledge, and diff) was encrypted with the current key. A new key cannot decrypt them — those records become unreadable forever. Back up the current key first if you might need the old history.',
              },
            },
            {
              type: 'input',
              block_id: 'confirm_block',
              label: { type: 'plain_text', text: `Type ${ROTATE_PHRASE} to confirm` },
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

  app.view('rotate_context_key_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const { workspaceId } = JSON.parse(view.private_metadata || '{}') as { workspaceId?: string };
    let acked = false;

    try {
      if (!(await requireManagerForAction({ client, userId }))) {
        await ack();
        return;
      }

      const typed = view.state.values.confirm_block?.confirm_input?.value?.trim();
      if (typed !== ROTATE_PHRASE) {
        await ack({
          response_action: 'errors',
          errors: { confirm_block: `Type ${ROTATE_PHRASE} exactly to confirm.` },
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
        text: '🔐 Provenance key rotated. New change history will use the new key; records made with the previous key are no longer readable.',
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
          errors: { confirm_block: 'Failed to rotate the key. Please try again.' },
        }).catch(() => {});
      } else {
        await client.chat
          .postEphemeral({
            user: userId,
            channel: userId,
            text: '❌ Failed to rotate the provenance key. Please try again.',
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
  app.action('backup_context_key', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();
    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) return;
      const workspaceId = await getWorkspaceId(client);
      const key = await new WorkspaceStore().getContextEncryptionKey(workspaceId);

      if (!key) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: 'No provenance key exists yet — it is generated on the first recorded document change.',
        });
        return;
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'backup_context_key_modal',
          title: { type: 'plain_text', text: 'Back Up Key' },
          close: { type: 'plain_text', text: 'Done' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Provenance key (base64).* Store this somewhere safe and private — anyone with it can decrypt this workspace’s change history. You will need it to read existing history after a key rotation or a database restore.',
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
  app.action('import_context_key', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();
    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id }))) return;
      const workspaceId = await getWorkspaceId(client);
      const configured = (await new WorkspaceStore().getContextKeyStatus(workspaceId)).configured;

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'import_context_key_modal',
          private_metadata: JSON.stringify({ workspaceId }),
          title: { type: 'plain_text', text: 'Import Key' },
          submit: { type: 'plain_text', text: 'Import' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: configured
                  ? '⚠️ Importing a key *replaces the current one*. Existing change history encrypted with the current key becomes unreadable unless you re-import that key later. Back it up first if unsure.'
                  : 'Set this workspace’s provenance key from a base64-encoded 32-byte key (e.g. a backup from another environment).',
              },
            },
            {
              type: 'input',
              block_id: 'key_block',
              label: { type: 'plain_text', text: 'Base64 key (32 bytes)' },
              element: {
                type: 'plain_text_input',
                action_id: 'key_input',
                placeholder: { type: 'plain_text', text: 'Paste the base64 key' },
              },
            },
            {
              type: 'input',
              block_id: 'confirm_block',
              label: { type: 'plain_text', text: `Type ${IMPORT_PHRASE} to confirm` },
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

  app.view('import_context_key_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const { workspaceId } = JSON.parse(view.private_metadata || '{}') as { workspaceId?: string };
    let acked = false;

    try {
      if (!(await requireManagerForAction({ client, userId }))) {
        await ack();
        return;
      }

      const typed = view.state.values.confirm_block?.confirm_input?.value?.trim();
      const keyB64 = view.state.values.key_block?.key_input?.value?.trim() || '';

      if (typed !== IMPORT_PHRASE) {
        await ack({
          response_action: 'errors',
          errors: { confirm_block: `Type ${IMPORT_PHRASE} exactly to confirm.` },
        });
        acked = true;
        return;
      }
      // Validate the key is a base64-encoded 32-byte value before touching state.
      const decoded = Buffer.from(keyB64, 'base64');
      if (!keyB64 || decoded.length !== 32) {
        await ack({
          response_action: 'errors',
          errors: { key_block: 'Enter a base64-encoded 32-byte key.' },
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
        text: '🔐 Provenance key imported. Change history recorded from now on uses it, and history encrypted with this key (e.g. a restored backup) is readable again.',
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
          errors: { key_block: 'Failed to import the key. Please try again.' },
        }).catch(() => {});
      } else {
        await client.chat
          .postEphemeral({
            user: userId,
            channel: userId,
            text: '❌ Failed to import the provenance key. Please try again.',
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
