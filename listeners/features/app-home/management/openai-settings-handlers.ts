import type { App, BlockAction } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { CURATED_GPT5_MODELS, invalidateModelCatalog, listGpt5Models } from 'services/llm/model-catalog';
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
  app.action('configure_openai', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();
    const userId = body.user.id;

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
          text: "❌ You don't have permission to configure OpenAI settings.",
        });
        return;
      }

      const workspaceStore = new WorkspaceStore();
      const existing = await workspaceStore.getOpenAISettings(workspaceId);

      // Pull the model catalog using whatever key is currently configured. If
      // none is set, fall back to the curated list so the dropdowns still work
      // on first configuration.
      const lookupKey = existing?.apiKey || process.env.OPENAI_API_KEY;
      const models = lookupKey ? await listGpt5Models(lookupKey) : CURATED_GPT5_MODELS;
      const selectableModels = models.length > 0 ? models : CURATED_GPT5_MODELS;

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
        ? `Current key: ${maskApiKey(existing.apiKey)}. Leave blank to keep it.`
        : 'Paste your OpenAI API key. It will be validated before saving.';

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'openai_settings_modal',
          title: { type: 'plain_text', text: 'OpenAI Settings' },
          submit: { type: 'plain_text', text: 'Save' },
          close: { type: 'plain_text', text: 'Cancel' },
          private_metadata: JSON.stringify({ workspaceId, hadKey: !!existing?.apiKey }),
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '🔐 *OpenAI API Key & Models*\nManage the key CHOIR uses for this workspace and pick which GPT-5 models power Q&A and document updates. Classification always uses a fixed model.',
              },
            },
            {
              type: 'input',
              block_id: 'api_key_block',
              optional: true,
              element: {
                type: 'plain_text_input',
                action_id: 'api_key_input',
                placeholder: { type: 'plain_text', text: 'sk-...' },
                ...(existing?.apiKey ? { initial_value: SENTINEL_UNCHANGED } : {}),
              },
              label: { type: 'plain_text', text: 'API Key' },
              hint: { type: 'plain_text', text: apiKeyHint },
            },
            {
              type: 'input',
              block_id: 'qa_model_block',
              optional: true,
              element: {
                type: 'static_select',
                action_id: 'qa_model_select',
                placeholder: { type: 'plain_text', text: 'Use default' },
                options: buildModelOptions(selectableModels),
                ...(qaInitial ? { initial_option: qaInitial } : {}),
              },
              label: { type: 'plain_text', text: 'Q&A Model' },
            },
            {
              type: 'input',
              block_id: 'document_update_model_block',
              optional: true,
              element: {
                type: 'static_select',
                action_id: 'document_update_model_select',
                placeholder: { type: 'plain_text', text: 'Use default' },
                options: buildModelOptions(selectableModels),
                ...(documentUpdateInitial ? { initial_option: documentUpdateInitial } : {}),
              },
              label: { type: 'plain_text', text: 'Document Update Model' },
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
        text: '❌ Error opening OpenAI settings. Please try again.',
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

  app.view('openai_settings_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();
    const userId = body.user.id;
    const metadata = JSON.parse(view.private_metadata || '{}') as { workspaceId?: string; hadKey?: boolean };
    const workspaceId = metadata.workspaceId || (await getWorkspaceId(client));

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
              api_key_block: `Key validation failed: ${validation.error || 'unknown error'}`,
            },
          });
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

      await ack();

      if (newKey && existing?.apiKey && existing.apiKey !== newKey) {
        invalidateClientCache(existing.apiKey);
        invalidateModelCatalog(existing.apiKey);
      }

      await workspaceStore.setOpenAISettings(workspaceId, {
        apiKey: newKey,
        qaModel,
        documentUpdateModel,
      });

      await client.chat.postMessage({
        channel: userId,
        text: '✅ OpenAI settings saved.',
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
      await ack({
        response_action: 'errors',
        errors: {
          api_key_block: 'An error occurred while saving. Please try again.',
        },
      });
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

  app.action<BlockAction>('clear_openai_settings', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();
    const userId = body.user.id;

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
        text: '✅ Workspace OpenAI settings cleared. CHOIR will fall back to the server default key.',
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
