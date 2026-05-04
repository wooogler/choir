import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { logManagementButtonError, logManagementModalError, refreshAppHomeSoon } from './shared';

export const registerReadonlyFilesHandlers = (app: App) => {
  app.action('manage_readonly_files', async ({ ack, body, client, logger }) => {
    const startTime = Date.now();
    await ack();

    try {
      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const readOnlyFiles = await workspaceStore.getReadOnlyFiles(workspaceId);
      const markdownFiles = await workspaceStore.getCachedMarkdownFiles(workspaceId);

      if (!markdownFiles || markdownFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ No markdown files found. Please connect to a GitHub repository first.',
        });
        return;
      }

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: 'readonly_files_modal',
          notify_on_close: true,
          title: {
            type: 'plain_text',
            text: 'Manage Read-Only Files',
          },
          submit: {
            type: 'plain_text',
            text: 'Update Files',
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '🔒 *Select Read-Only Files*\n\nRead-only files are excluded from document updates but remain searchable. Choose which files should be protected from automatic updates.',
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📊 *Current Status:* ${readOnlyFiles.length} of ${markdownFiles.length} files are read-only`,
              },
            },
            {
              type: 'input',
              block_id: 'readonly_files_select_block',
              element: {
                type: 'multi_static_select',
                action_id: 'readonly_files_select',
                ...(readOnlyFiles.length > 0 && {
                  initial_options: readOnlyFiles
                    .filter((fileName) => markdownFiles.some((file) => file.name === fileName))
                    .map((fileName) => ({
                      text: {
                        type: 'plain_text',
                        text: fileName,
                      },
                      value: fileName,
                    })),
                }),
                options: markdownFiles.map((file) => ({
                  text: {
                    type: 'plain_text',
                    text: file.name,
                  },
                  value: file.name,
                })),
                placeholder: {
                  type: 'plain_text',
                  text: 'Select files to mark as read-only...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Select files to mark as read-only',
              },
              optional: true,
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: "💡 *Tip:* Read-only files can still be searched and referenced, but they won't be modified during document updates.",
                },
              ],
            },
          ],
        },
      });

      await logAppHomeButtonClick(
        body.user.id,
        workspaceId,
        'manage_readonly_files',
        Date.now() - startTime,
        true,
        'Manage Read-Only Files',
        {
          currentReadOnlyCount: readOnlyFiles.length,
          totalFilesCount: markdownFiles.length,
        },
        client,
      );
    } catch (error) {
      logger.error('Error opening read-only files management modal:', error);

      if ('user' in body && body.user?.id) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: '❌ Error opening read-only files management modal. Please try again.',
        });
      }

      await logManagementButtonError({
        userId: body.user.id,
        actionId: 'manage_readonly_files',
        actionLabel: 'Manage Read-Only Files',
        startTime,
        error,
        client,
        logger,
      });
    }
  });

  app.view('readonly_files_modal', async ({ ack, body, client, logger, view }) => {
    const startTime = Date.now();

    try {
      const selectedFiles =
        view.state.values.readonly_files_select_block.readonly_files_select.selected_options?.map(
          (option) => option.value,
        ) || [];

      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const success = await workspaceStore.setReadOnlyFiles(workspaceId, selectedFiles);

      if (success) {
        await ack();

        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: `✅ Read-only files updated successfully! ${selectedFiles.length} files are now marked as read-only. Please refresh your app home to see the changes.`,
        });

        refreshAppHomeSoon({ client, logger, userId: body.user.id, reason: 'read-only files update' });

        logger.info('Read-only files updated via modal', {
          workspaceId,
          userId: body.user.id,
          readOnlyFilesCount: selectedFiles.length,
          readOnlyFiles: selectedFiles,
        });

        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'readonly_files_modal',
          Date.now() - startTime,
          true,
          `Read-only files updated: ${selectedFiles.join(', ')}`,
          {
            readOnlyFilesCount: selectedFiles.length,
            readOnlyFiles: selectedFiles,
          },
          client,
        );
      } else {
        await ack({
          response_action: 'errors',
          errors: {
            readonly_files_select_block: 'Failed to update read-only files. Please try again.',
          },
        });

        await logAppHomeModalSubmit(
          body.user.id,
          workspaceId,
          'readonly_files_modal',
          Date.now() - startTime,
          false,
          `Read-only files update failed: ${selectedFiles.join(', ')}`,
          {
            error: 'Failed to update read-only files',
            readOnlyFilesCount: selectedFiles.length,
            readOnlyFiles: selectedFiles,
          },
          client,
        );
      }
    } catch (error) {
      logger.error('Error processing read-only files modal:', error);

      await ack({
        response_action: 'errors',
        errors: {
          readonly_files_select_block: 'An error occurred while updating read-only files. Please try again.',
        },
      });

      await logManagementModalError({
        userId: body.user.id,
        callbackId: 'readonly_files_modal',
        message: 'Read-only files modal error',
        startTime,
        error,
        client,
        logger,
      });
    }
  });
};
