import type { Document } from '@langchain/core/documents';
import { SessionType, generateSessionId, storeSessionData } from 'services/common';
import type { DocumentMetadata } from 'services/file-registry/types';
import { GithubService } from 'services/github';
import { getUserName, getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { CREATE_FILE_SESSION_EXPIRY } from './shared';

export async function showFileSelectionDropdown(
  client: any,
  userId: string,
  currentDmChannelId: string,
  searchResults: Document<DocumentMetadata>[],
  knowledgeContent: string,
  sessionId: string,
  knowledgeSourceChannelId?: string,
  knowledgeSourceThreadTs?: string,
  progressMessageTs?: string,
  newFileDefaults?: { fileName: string; initialContent: string },
) {
  const workspaceId = await getWorkspaceId(client);
  const workspaceStore = new WorkspaceStore();
  const config = await workspaceStore.getWorkspaceConfig(workspaceId);

  if (!config || !config.githubRepo) {
    throw new Error('Workspace configuration or GitHub repository not found');
  }

  let fileList = await workspaceStore.getWritableFiles(workspaceId);

  if (!fileList || fileList.length === 0) {
    const { owner, repo, path } = config.githubRepo;
    const githubService = GithubService.getInstance();
    const markdownFiles = await githubService.getAllMarkdownFiles({
      owner,
      repo,
      path,
      workspaceId,
      userId,
    });

    await workspaceStore.setMarkdownFilesCache(
      workspaceId,
      markdownFiles.map((file) => ({ name: file.name, path: file.path })),
    );

    fileList = await workspaceStore.getWritableFiles(workspaceId);
  }

  if (!fileList || fileList.length === 0) {
    await client.chat.postEphemeral({
      channel: userId,
      user: userId,
      text: '❌ No writable files available for document updates. All files are marked as read-only.',
    });
    return;
  }

  const fileOptions = fileList.map((file) => ({
    text: { type: 'plain_text' as const, text: file.name },
    value: file.path,
  }));

  const defaultFilePath = searchResults[0]?.metadata?.fileName || fileOptions[0]?.value;
  const defaultFileOption =
    fileOptions.find((option) => option.value === defaultFilePath || option.text.text === defaultFilePath) ||
    fileOptions[0];

  if (defaultFileOption) {
    defaultFileOption.text.text += ' (Recommended)';
  }

  const _userName = await getUserName(userId, client);

  const fileSelectionBlocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '📁 *Which file would you like to update?*' },
      block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
      accessory: {
        type: 'static_select',
        action_id: 'file_selection_for_update',
        placeholder: { type: 'plain_text', text: 'Choose a specific file...' },
        options: fileOptions,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Start Review', emoji: false },
          style: 'primary',
          action_id: 'start_file_based_review',
          value: JSON.stringify({
            sessionId,
            knowledgeContent,
            knowledgeSourceChannelId,
            knowledgeSourceThreadTs,
            selectedFile: null,
            defaultFilePath,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📄 Create New File', emoji: true },
          action_id: 'show_create_file_modal',
          value: (() => {
            const createFileSessionId = generateSessionId('create_file');
            storeSessionData(
              createFileSessionId,
              {
                sessionId,
                knowledgeContent,
                knowledgeSourceChannelId,
                knowledgeSourceThreadTs,
                ...(newFileDefaults && {
                  defaultFileName: newFileDefaults.fileName,
                  defaultInitialContent: newFileDefaults.initialContent,
                }),
              },
              SessionType.CREATE_FILE_MODAL,
              CREATE_FILE_SESSION_EXPIRY,
            );
            return createFileSessionId;
          })(),
        },
      ],
    },
  ];

  if (progressMessageTs) {
    try {
      await client.chat.update({
        channel: currentDmChannelId,
        ts: progressMessageTs,
        text: '📁 Which file would you like to update?',
        blocks: fileSelectionBlocks,
      });
      return progressMessageTs;
    } catch (updateError: any) {
      console.warn(`Failed to update progress message ${progressMessageTs}:`, updateError?.message || updateError);
      const message = await client.chat.postMessage({
        channel: currentDmChannelId,
        text: '📁 Which file would you like to update?',
        blocks: fileSelectionBlocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      return message.ts;
    }
  } else {
    const message = await client.chat.postMessage({
      channel: currentDmChannelId,
      text: '📁 Which file would you like to update?',
      blocks: fileSelectionBlocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    return message.ts;
  }
}
