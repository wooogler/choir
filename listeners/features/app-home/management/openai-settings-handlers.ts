import type { App, BlockAction } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { CURATED_MODELS, invalidateModelCatalog, listSelectableModels } from 'services/llm/model-catalog';
import { invalidateClientCache, validateOpenAIKey } from 'services/llm/openai-client-factory';
import { getWorkspaceId, isManager, isWorkspaceOwner } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { refreshAppHomeSoon } from '../refresh';
import { logManagementButtonError, logManagementModalError } from './shared';

const SENTINEL_UNCHANGED = '__keep_existing_api_key__';

function buildModelOptions(models: string[]): Array<{ text: { type: 'plain_text'; text: string }; value: string }> {
  return models.map((model) => ({
    text: { type: 'plain_text' as const, text: model },
    value: model,
  }));
}

function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return 'Not set';
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export const registerOpenAISettingsHandlers = (app: App) => {
  app.action('configure_openai', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();
    const userId = body.user.id;
    const t = tForRequest(context);

    try {
      const workspaceId = await getWorkspaceId(client);
      const [isUserManager, isOwner] = await Promise.all([
        isManager(workspaceId, userId),
        isWorkspaceOwner(userId, client),
      ]);
      if (!isUserManager && !isOwner) {
        await client.chat.postEphemeral({
          user: userId,
          channel: userId,
          text: t('appHome.management.openai.error.permission'),
        });
        return;
      }

      const workspaceStore = new WorkspaceStore();
      const existing = await workspaceStore.getOpenAISettings(workspaceId);

      // Pull the model catalog using whatever key is currently configured. If
      // none is set, fall back to the curated list so the dropdowns still work
      // on first configuration.
      const lookupKey = existing?.apiKey || process.env.OPENAI_API_KEY;
      const models = lookupKey ? await listSelectableModels(lookupKey) : CURATED_MODELS;
      const selectableModels = models.length > 0 ? models : CURATED_MODELS;

      const findInitial = (value: string | undefined) => {
        if (!value || !selectableModels.includes(value)) return undefined;
        return {
          text: { type: 'plain_text' as const, text: value },
          value,
        };
      };

      const qaInitial = findInitial(existing?.qaModel);
      const documentUpdateInitial = findInitial(existing?.documentUpdateModel);

      const apiKeyHint = existing?.apiKey
        ? t('appHome.management.openai.apiKey.hint.existing', { masked: maskApiKey(existing.apiKey) })
        : t('appHome.management.openai.apiKey.hint.new');

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'openai_settings_modal',
          title: { type: 'plain_text', text: t('appHome.management.openai.title') },
          submit: { type: 'plain_text', text: t('appHome.management.openai.submit') },
          close: { type: 'plain_text', text: t('common.button.cancel') },
          private_metadata: JSON.stringify({ workspaceId, hadKey: !!existing?.apiKey }),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.openai.intro'),
              },
            },
            {
              type: 'input',
              block_id: 'api_key_block',
              optional: true,
              element: {
                type: 'plain_text_input',
                action_id: 'api_key_input',
                placeholder: { type: 'plain_text', text: t('appHome.management.openai.apiKey.placeholder') },
                ...(existing?.apiKey ? { initial_value: SENTINEL_UNCHANGED } : {}),
              },
              label: { type: 'plain_text', text: t('appHome.management.openai.apiKey.label') },
              hint: { type: 'plain_text', text: apiKeyHint },
            },
            {
              type: 'input',
              block_id: 'qa_model_block',
              optional: true,
              element: {
                type: 'static_select',
                action_id: 'qa_model_select',
                placeholder: { type: 'plain_text', text: t('appHome.management.openai.model.placeholder') },
                options: buildModelOptions(selectableModels),
                ...(qaInitial ? { initial_option: qaInitial } : {}),
              },
              label: { type: 'plain_text', text: t('appHome.management.openai.qaModel.label') },
            },
            {
              type: 'input',
              block_id: 'document_update_model_block',
              optional: true,
              element: {
                type: 'static_select',
                action_id: 'document_update_model_select',
                placeholder: { type: 'plain_text', text: t('appHome.management.openai.model.placeholder') },
                options: buildModelOptions(selectableModels),
                ...(documentUpdateInitial ? { initial_option: documentUpdateInitial } : {}),
              },
              label: { type: 'plain_text', text: t('appHome.management.openai.documentUpdateModel.label') },
            },
          ],
        },
      });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        'configure_openai',
        Date.now() - startTime,
        true,
        'Configure OpenAI',
        { hadKey: !!existing?.apiKey, modelCount: selectableModels.length },
        client,
      );
    } catch (error) {
      logger.error('Error opening OpenAI settings modal:', error);
      await client.chat.postEphemeral({
        user: userId,
        channel: userId,
        text: t('appHome.management.openai.error.open'),
      });
      await logManagementButtonError({
        userId,
        actionId: 'configure_openai',
        actionLabel: 'Configure OpenAI',
        startTime,
        error,
        client,
        logger,
      });
    }
  });

  app.view('openai_settings_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const t = tForRequest(context);
    const metadata = JSON.parse(view.private_metadata || '{}') as { workspaceId?: string; hadKey?: boolean };
    const workspaceId = metadata.workspaceId || (await getWorkspaceId(client));
    // Track whether the modal has been acknowledged: once we ack (which closes the
    // modal), a later failure can no longer be surfaced as a modal error, so the
    // catch must fall back to a DM instead of a second, silently-ignored ack.
    let acked = false;

    try {
      const rawApiKey = view.state.values.api_key_block?.api_key_input?.value?.trim() || '';
      const qaModel = view.state.values.qa_model_block?.qa_model_select?.selected_option?.value;
      const documentUpdateModel =
        view.state.values.document_update_model_block?.document_update_model_select?.selected_option?.value;

      const workspaceStore = new WorkspaceStore();
      const existing = await workspaceStore.getOpenAISettings(workspaceId);
      const keepExisting = !rawApiKey || rawApiKey === SENTINEL_UNCHANGED;
      const newKey = keepExisting ? undefined : rawApiKey;

      if (!keepExisting && newKey) {
        const validation = await validateOpenAIKey(newKey);
        if (!validation.valid) {
          await ack({
            response_action: 'errors',
            errors: {
              api_key_block: t('appHome.management.openai.error.validation', {
                reason: validation.error || t('appHome.management.openai.error.unknownReason'),
              }),
            },
          });
          acked = true;
          await logAppHomeModalSubmit(
            userId,
            workspaceId,
            'openai_settings_modal',
            Date.now() - startTime,
            false,
            'OpenAI key validation failed',
            { error: validation.error },
            client,
          );
          return;
        }
      }

      // Persist BEFORE acking so a save failure still shows an in-modal error
      // rather than closing the modal on a change that never took effect.
      if (newKey && existing?.apiKey && existing.apiKey !== newKey) {
        invalidateClientCache(existing.apiKey);
        invalidateModelCatalog(existing.apiKey);
      }

      await workspaceStore.setOpenAISettings(workspaceId, {
        apiKey: newKey,
        qaModel,
        documentUpdateModel,
      });

      await ack();
      acked = true;

      await client.chat.postMessage({
        channel: userId,
        text: t('appHome.management.openai.saved'),
      });

      refreshAppHomeSoon({ client, logger, userId, reason: 'OpenAI settings update' });

      await logAppHomeModalSubmit(
        userId,
        workspaceId,
        'openai_settings_modal',
        Date.now() - startTime,
        true,
        'OpenAI settings updated',
        {
          keyRotated: !!newKey,
          qaModel: qaModel || null,
          documentUpdateModel: documentUpdateModel || null,
        },
        client,
      );
    } catch (error) {
      logger.error('Error saving OpenAI settings:', error);
      if (acked) {
        // Modal already closed; the only way left to tell the user is a DM.
        await client.chat
          .postMessage({
            channel: userId,
            text: t('appHome.management.openai.error.postAck'),
          })
          .catch((dmError) => logger.error('Failed to notify OpenAI settings post-ack failure:', dmError));
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            api_key_block: t('appHome.management.openai.error.save'),
          },
        });
      }
      await logManagementModalError({
        userId,
        callbackId: 'openai_settings_modal',
        message: 'OpenAI settings save error',
        startTime,
        error,
        client,
        logger,
      });
    }
  });

  app.action<BlockAction>('clear_openai_settings', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();
    const userId = body.user.id;
    const t = tForRequest(context);

    try {
      const workspaceId = await getWorkspaceId(client);
      const [isUserManager, isOwner] = await Promise.all([
        isManager(workspaceId, userId),
        isWorkspaceOwner(userId, client),
      ]);
      if (!isUserManager && !isOwner) {
        return;
      }

      const workspaceStore = new WorkspaceStore();
      const existing = await workspaceStore.getOpenAISettings(workspaceId);
      if (existing?.apiKey) {
        invalidateClientCache(existing.apiKey);
        invalidateModelCatalog(existing.apiKey);
      }
      await workspaceStore.clearOpenAISettings(workspaceId);

      await client.chat.postMessage({
        channel: userId,
        text: t('appHome.management.openai.cleared'),
      });

      refreshAppHomeSoon({ client, logger, userId, reason: 'OpenAI settings cleared' });

      await logAppHomeButtonClick(
        userId,
        workspaceId,
        'clear_openai_settings',
        Date.now() - startTime,
        true,
        'Clear OpenAI Settings',
        {},
        client,
      );
    } catch (error) {
      logger.error('Error clearing OpenAI settings:', error);
      await logManagementButtonError({
        userId,
        actionId: 'clear_openai_settings',
        actionLabel: 'Clear OpenAI Settings',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
