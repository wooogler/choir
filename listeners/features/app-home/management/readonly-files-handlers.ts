import type { App } from '@slack/bolt';
import { logAppHomeButtonClick, logAppHomeModalSubmit } from 'services/common/interaction-tracker';
import { tForRequest } from 'services/i18n';
import { getWorkspaceId } from 'services/slack';
import { isReadOnlyFolderEntry } from 'services/workspace/read-only';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import {
  logManagementButtonError,
  logManagementModalError,
  refreshAppHomeSoon,
  requireManagerForAction,
} from './shared';

// Slack caps plain_text option labels at 75 chars.
const OPTION_TEXT_LIMIT = 75;
const truncateOptionText = (text: string): string =>
  text.length > OPTION_TEXT_LIMIT ? `${text.slice(0, OPTION_TEXT_LIMIT - 1)}…` : text;

/**
 * Every folder that holds a markdown file, as a `folder/` entry.
 *
 * Folders are not stored anywhere — the file list is the only inventory CHOIR
 * has — so they are derived from the paths, every level of them, so that
 * `projects/` can be protected as readily as `projects/alpha/meetings/`.
 * The trailing slash is what `isReadOnlyFile` reads as "this is a prefix"
 * (docs/project-folders.md 6).
 */
const folderEntriesOf = (files: ReadonlyArray<{ path: string }>): string[] => {
  const folders = new Set<string>();
  for (const file of files) {
    const segments = file.path.split('/');
    segments.pop();
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      folders.add(`${prefix}/`);
    }
  }
  return [...folders].sort();
};

export const registerReadonlyFilesHandlers = (app: App) => {
  // Typeahead options for the read-only file picker. Using an external select (vs
  // a static one) avoids Slack's 100-option cap, which broke the modal — and the
  // whole App Home — for repos with more than 100 markdown files.
  app.options('readonly_files_select', async ({ options, ack, client }) => {
    try {
      const workspaceId = await getWorkspaceId(client);
      const files = (await new WorkspaceStore().getCachedMarkdownFiles(workspaceId)) || [];
      const query = (options.value || '').toLowerCase();
      // Folders first: someone typing "meetings" almost always means the folder
      // when both exist, and the file is right underneath it either way.
      const folders = folderEntriesOf(files).filter((folder) => !query || folder.toLowerCase().includes(query));
      const paths = files
        .filter((file) => !query || file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query))
        .map((file) => file.path);
      const matched = [...folders, ...paths].slice(0, 100).map((entry) => ({
        // Key by full path so two files with the same basename are distinct.
        text: { type: 'plain_text' as const, text: truncateOptionText(entry) },
        value: entry,
      }));
      await ack({ options: matched });
    } catch {
      await ack({ options: [] });
    }
  });

  app.action('manage_readonly_files', async ({ ack, body, client, context, logger }) => {
    const startTime = Date.now();
    await ack();

    const t = tForRequest(context);

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) {
        return;
      }

      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new WorkspaceStore();
      const readOnlyFiles = await workspaceStore.getReadOnlyFiles(workspaceId);
      const markdownFiles = await workspaceStore.getCachedMarkdownFiles(workspaceId);

      if (!markdownFiles || markdownFiles.length === 0) {
        await client.chat.postEphemeral({
          user: body.user.id,
          channel: body.user.id,
          text: t('appHome.management.readOnly.error.noFiles'),
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
            text: t('appHome.management.readOnly.title'),
          },
          submit: {
            type: 'plain_text',
            text: t('appHome.management.readOnly.submit'),
          },
          close: {
            type: 'plain_text',
            text: t('common.button.cancel'),
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.readOnly.intro'),
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: t('appHome.management.readOnly.status', {
                  count: readOnlyFiles.length,
                  total: markdownFiles.length,
                }),
              },
            },
            {
              type: 'input',
              block_id: 'readonly_files_select_block',
              element: {
                // External (typeahead) select so repos with >100 files don't
                // exceed the static-select option cap and break the modal.
                type: 'multi_external_select',
                action_id: 'readonly_files_select',
                min_query_length: 0,
                ...(readOnlyFiles.length > 0 && {
                  // Reflect currently-marked entries. A `folder/` entry stands
                  // for itself; a file entry is a path going forward but may be
                  // a legacy basename, so resolve it to the matching file and
                  // the picker re-saves it as a path. Dedup — a legacy basename
                  // can resolve to the same file as an explicit path entry, and
                  // Slack rejects duplicate options.
                  initial_options: [
                    ...new Set(
                      readOnlyFiles
                        .map((entry) =>
                          isReadOnlyFolderEntry(entry)
                            ? entry
                            : markdownFiles.find((file) => file.path === entry || file.name === entry)?.path,
                        )
                        .filter((entry): entry is string => !!entry),
                    ),
                  ].map((entry) => ({
                    text: {
                      type: 'plain_text',
                      text: truncateOptionText(entry),
                    },
                    value: entry,
                  })),
                }),
                placeholder: {
                  type: 'plain_text',
                  text: t('appHome.management.readOnly.placeholder'),
                },
              },
              label: {
                type: 'plain_text',
                text: t('appHome.management.readOnly.label'),
              },
              optional: true,
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: t('appHome.management.readOnly.tip'),
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
          text: t('appHome.management.readOnly.error.open'),
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

  app.view('readonly_files_modal', async ({ ack, body, client, context, logger, view }) => {
    const startTime = Date.now();
    const t = tForRequest(context);

    try {
      if (!(await requireManagerForAction({ client, userId: body.user.id, t }))) {
        await ack();
        return;
      }

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
          text: t('appHome.management.readOnly.updated', { count: selectedFiles.length }),
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
            readonly_files_select_block: t('appHome.management.readOnly.error.save'),
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
          readonly_files_select_block: t('appHome.management.readOnly.error.generic'),
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
