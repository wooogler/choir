import {
  SessionType,
  deleteProgressMessageTimestamp,
  generateSessionId,
  getProgressMessageTimestamp,
  storeSessionData,
} from 'services/common';
import { clearFileSelectionState } from 'services/document/document-store';
import { GithubService } from 'services/github';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';
import { CREATE_FILE_SESSION_EXPIRY } from '../shared';

export async function handleCompletion(params: {
  userId: string;
  currentWorkspaceId: string;
  currentDmChannelId: string;
  client: any;
  logger: any;
  knowledgeContent: string;
  knowledgeSourceChannelId: string | undefined;
  knowledgeSourceThreadTs: string | undefined;
  sessionId: string;
}): Promise<void> {
  const {
    userId,
    currentWorkspaceId,
    currentDmChannelId,
    client,
    logger,
    knowledgeContent,
    knowledgeSourceChannelId,
    knowledgeSourceThreadTs,
    sessionId,
  } = params;

  const progressTimestamp = getProgressMessageTimestamp(userId);
  if (progressTimestamp && currentDmChannelId) {
    try {
      await client.chat.delete({
        channel: currentDmChannelId,
        ts: progressTimestamp,
      });
      deleteProgressMessageTimestamp(userId);
      logger.info('Deleted progress message before showing completion');
    } catch (deleteError) {
      logger.warn('Failed to delete progress message:', deleteError);
    }
  }

  try {
    const workspaceId = await getWorkspaceId(client);
    const workspaceStore = new WorkspaceStore();
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);

    let fileList = await workspaceStore.getWritableFiles(workspaceId);
    if ((!fileList || fileList.length === 0) && config?.githubRepo) {
      const { owner, repo, path } = config.githubRepo;
      const githubService = GithubService.getInstance();
      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner,
        repo,
        path,
        workspaceId: workspaceId,
        userId: userId,
      });

      await workspaceStore.setMarkdownFilesCache(
        workspaceId,
        markdownFiles.map((file) => ({
          name: file.name,
          path: file.path,
        })),
      );

      fileList = await workspaceStore.getWritableFiles(workspaceId);
    }

    let newSectionSessionId: string | null = null;
    let completionNewFileDefaults: { fileName: string; initialContent: string } | undefined;

    try {
      const { createNewSectionFromKnowledge, generateNewFileDefaults } = await import('services/llm/content-generator');
      const branchName = config?.githubRepo
        ? config.githubRepo.branch ||
          (await GithubService.getInstance().getDefaultBranch(
            config.githubRepo.owner,
            config.githubRepo.repo,
            workspaceId,
            userId,
          ))
        : 'main';
      const availableFiles = (fileList || []).map((file) => ({
        fileName: file.name,
        githubUrl: `https://github.com/${config?.githubRepo?.owner}/${config?.githubRepo?.repo}/blob/${branchName}/${file.path}`,
        description: `${file.name} - Documentation file`,
      }));

      if (availableFiles.length > 0) {
        const newSectionSuggestion = await createNewSectionFromKnowledge(
          knowledgeContent,
          availableFiles,
          workspaceId,
        );

        if (newSectionSuggestion) {
          newSectionSessionId = `new_section_${userId}_${Date.now()}`;
          const recommendedFileInfo = availableFiles.find(
            (file) => file.fileName === newSectionSuggestion.recommendedFile,
          );
          const githubUrl = recommendedFileInfo?.githubUrl || availableFiles[0]?.githubUrl || '';

          storeSessionData(
            newSectionSessionId,
            {
              sectionTitle: newSectionSuggestion.sectionTitle,
              sectionContent: newSectionSuggestion.sectionContent,
              recommendedFile: newSectionSuggestion.recommendedFile,
              reasoning: newSectionSuggestion.reasoning,
              githubUrl: githubUrl,
              originalChannelId: knowledgeSourceChannelId,
              originalThreadTs: knowledgeSourceThreadTs,
              sessionId: sessionId,
            },
            SessionType.NEW_SECTION,
          );
        }

        completionNewFileDefaults = await generateNewFileDefaults(knowledgeContent, fileList || [], workspaceId);
        logger.info(`Generated completion new file defaults: ${completionNewFileDefaults.fileName}`);
      }
    } catch (error) {
      logger.warn('Failed to create new section suggestion for completion:', error);
    }

    const completionBlocks = [
      {
        type: 'section',
        block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
        text: {
          type: 'mrkdwn',
          text: "🎉 *Review Complete!* We've gone through all relevant documents. \n\nWould you like to create new content instead?",
        },
      },
      {
        type: 'actions',
        elements: [
          ...(newSectionSessionId
            ? [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '💡 Create New Section', emoji: true },
                  action_id: 'create_new_section',
                  value: JSON.stringify({ newSectionSessionId, userId }),
                },
              ]
            : []),
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
                  ...(completionNewFileDefaults && {
                    defaultFileName: completionNewFileDefaults.fileName,
                    defaultInitialContent: completionNewFileDefaults.initialContent,
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
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Or mention me anytime with new knowledge to review and update docs! 👋' }],
      },
    ];

    await client.chat.postMessage({
      channel: currentDmChannelId,
      text: '🎉 Review Complete! Create new content?',
      blocks: completionBlocks,
      unfurl_links: false,
      unfurl_media: false,
    });

    logger.info('Successfully sent completion message with new options');
  } catch (error) {
    logger.error('Error creating completion message:', error);

    await client.chat.postMessage({
      channel: currentDmChannelId,
      text: "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          text: {
            type: 'mrkdwn',
            text: "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",
          },
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  clearFileSelectionState(userId, currentWorkspaceId);
  logger.info(`Cleared file selection state for user ${userId} after completion`);
}
