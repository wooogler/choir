import type { AllMiddlewareArgs, SlackViewMiddlewareArgs, ViewSubmitAction } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logModalSubmit } from 'services/common/interaction-tracker';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { type ProvenanceRecord, buildContextFile, persistContextToMirror } from 'services/document/provenance';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { getUserName, getWorkspaceId, resolveUserNames } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * Handle create file modal submission
 */
export const createFileSubmissionCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  const startTime = Date.now();

  try {
    // Parse private metadata
    const metadata = JSON.parse(body.view.private_metadata || '{}');
    const { createFileSessionId, userId, channelId } = metadata;

    // Get data from session store
    const sessionData = getSessionData(createFileSessionId, SessionType.CREATE_FILE_MODAL);
    if (!sessionData) {
      throw new Error('Session data not found or expired');
    }

    const { sessionId, knowledgeContent, knowledgeSourceChannelId, knowledgeSourceThreadTs } = sessionData;

    // Extract form values
    const fileName = body.view.state.values.file_name_input.file_name.value;
    const fileContent = body.view.state.values.file_content_input.file_content.value;

    // Validate inputs
    if (!fileName || !fileContent) {
      await ack({
        response_action: 'errors',
        errors: {
          ...(fileName ? {} : { file_name_input: 'File name is required' }),
          ...(fileContent ? {} : { file_content_input: 'File content is required' }),
        },
      });
      return;
    }

    // Validate file extension
    if (!fileName.endsWith('.md')) {
      await ack({
        response_action: 'errors',
        errors: {
          file_name_input: 'File name must end with .md extension',
        },
      });
      return;
    }

    // Validate file name format (basic checks)
    const fileNameRegex = /^[a-zA-Z0-9._-]+\.md$/;
    if (!fileNameRegex.test(fileName)) {
      await ack({
        response_action: 'errors',
        errors: {
          file_name_input:
            'File name contains invalid characters. Use only letters, numbers, dots, hyphens, and underscores.',
        },
      });
      return;
    }

    await ack();

    // Show processing message
    const processingMessage = await client.chat.postMessage({
      channel: channelId,
      text: '📄 Creating new file...',
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
          text: {
            type: 'mrkdwn',
            text: `📄 *Creating new file: ${fileName}*\nPlease wait while I create the file in your GitHub repository...`,
          },
        },
      ],
    });
    const updateProcessingMessage = async (message: { text: string; blocks: any[] }) => {
      if (processingMessage.ts) {
        await client.chat.update({
          channel: channelId,
          ts: processingMessage.ts,
          ...message,
        });
        return;
      }

      logger.warn('Processing message timestamp missing; posting a new status message instead.');
      await client.chat.postMessage({
        channel: channelId,
        ...message,
      });
    };

    // Get workspace configuration
    const workspaceId = await getWorkspaceId(client);
    const workspaceStore = new WorkspaceStore();
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);

    if (!config || !config.githubRepo) {
      throw new Error('Workspace configuration or GitHub repository not found');
    }

    const { owner, repo, path, branch } = config.githubRepo;
    const githubService = GithubService.getInstance();
    const documentUpdateService = DocumentUpdateService.getInstance();
    const branchName = branch || (await githubService.getDefaultBranch(owner, repo, workspaceId, userId));

    // Create the file in GitHub
    const filePath = path ? `${path}/${fileName}` : fileName;

    // The Git Data API tree write would silently overwrite an existing path, so
    // guard explicitly (createFile used to reject duplicates internally).
    const existingFile = await githubService.getFile({
      owner,
      repo,
      path: filePath,
      branch: branchName,
      workspaceId,
      userId,
    });
    if (existingFile) {
      await updateProcessingMessage({
        text: '❌ File creation failed',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: {
              type: 'mrkdwn',
              text: `❌ *File creation failed*\n\nA file named \`${fileName}\` already exists in the repository. Please choose a different file name.`,
            },
          },
        ],
      });
      return;
    }

    // Commit the new file together with its encrypted provenance record.
    const docUpdateSession = sessionId ? (getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any) : null;
    const sourceMessages: Array<Record<string, any>> =
      docUpdateSession?.sourceMessages ?? docUpdateSession?.messages ?? [];
    const updatedByName = await getUserName(userId, client).catch(() => undefined);
    const nameById = await resolveUserNames(
      sourceMessages.map((m) => m.user),
      client,
    );
    const record: ProvenanceRecord = {
      version: 1,
      type: 'new-file',
      file: { path: filePath, name: fileName },
      createdAt: new Date().toISOString(),
      updatedBy: { userId, name: updatedByName },
      source: { channelId: knowledgeSourceChannelId, threadTs: knowledgeSourceThreadTs },
      knowledge: knowledgeContent ?? '',
      messages: sourceMessages.map((m) => ({
        userId: m.user,
        username: m.user ? nameById.get(m.user) : undefined,
        text: m.text,
        ts: m.ts,
      })),
      diff: { before: '', after: fileContent },
    };
    const contextFile = await buildContextFile({ workspaceId, docPath: filePath, record });

    await githubService.commitFilesWithContext({
      owner,
      repo,
      branch: branchName,
      message: `Create ${fileName}`,
      files: [{ path: filePath, content: fileContent }, contextFile],
      workspaceId,
      userId,
    });
    await persistContextToMirror(workspaceId, contextFile);

    logger.info(`Successfully created file ${filePath} in GitHub repository ${owner}/${repo}`);

    // Reload and index the new file with web content enhancement
    const vectorStore = VectorStoreService.getInstance();

    try {
      // Get the created file and add it to vector store
      const createdFile = await githubService.getFile({
        owner,
        repo,
        path: filePath,
        branch: branchName,
        workspaceId,
        userId,
      });

      if (createdFile) {
        await documentUpdateService.persistRemoteFile({
          workspaceId,
          filePath,
          content: createdFile.content,
          owner,
          repo,
          branch: branchName,
          source: 'create-file',
        });

        // Create MarkdownFile object similar to initial load
        const { parseMarkdownToTree } = await import('services/document/markdown');
        const markdownFile: any = {
          name: fileName,
          path: filePath,
          content: createdFile.content,
          githubUrl: `https://github.com/${owner}/${repo}/blob/${branchName}/${filePath}`,
          tree: parseMarkdownToTree(createdFile.content),
        };

        // Register new file in the in-memory file list; QMD index updates on next sync
        vectorStore.addToMarkdownFiles(markdownFile, workspaceId);
        logger.info(`Registered new file ${fileName} in markdown file registry`);

        // Update workspace config file list (similar to reload)
        try {
          const { WorkspaceStore } = await import('services/workspace/workspace-store');
          const workspaceStore = new WorkspaceStore();

          // Get current cached file list
          const currentFiles = (await workspaceStore.getMarkdownFilesCache(workspaceId)) || [];

          // Add the new file to the list if not already present
          const fileExists = currentFiles.some(
            (f: { name: string; path: string }) => f.name === fileName || f.path === filePath,
          );
          if (!fileExists) {
            const updatedFiles = [...currentFiles, { name: fileName, path: filePath }];
            await workspaceStore.setMarkdownFilesCache(workspaceId, updatedFiles);
            logger.info(`Updated workspace config with new file: ${fileName}`);
          }
        } catch (configError) {
          logger.warn(`Failed to update workspace config for new file ${fileName}:`, configError);
          // Continue execution even if config update fails
        }
      }
    } catch (indexError) {
      logger.warn(`Failed to index new file ${fileName}:`, indexError);
      // Continue execution even if indexing fails
    }

    // Update processing message to success (without Start Review button - process ends here)
    await updateProcessingMessage({
      text: '✅ File created successfully!',
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          text: {
            type: 'mrkdwn',
            text: `✅ *File created successfully!*\n\n📄 <https://github.com/${owner}/${repo}/blob/${branchName}/${filePath}|*${fileName}*> has been created in your GitHub repository.`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Initial Content:*\n\`\`\`${fileContent.substring(0, 300)}${fileContent.length > 300 ? '...' : ''}\`\`\``,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🎉 *Document update process complete!*\nYour new file has been created and is ready for use. You can mention me anytime with new knowledge to review and update docs!',
          },
        },
      ],
    });

    // Send notification to original channel if available (and different from current DM)
    if (knowledgeSourceChannelId && knowledgeSourceChannelId !== channelId) {
      try {
        // Get user name for notification
        let createdBy = 'User';
        try {
          const userInfo = await client.users.info({ user: userId });
          createdBy = userInfo.user?.real_name || userInfo.user?.name || 'User';
        } catch (error) {
          logger.warn('Failed to get user info for notification:', error);
        }

        const notificationText = `📄 New File Created by ${createdBy}: <https://github.com/${owner}/${repo}/blob/${branchName}/${filePath}|${fileName}>`;

        await client.chat.postMessage({
          channel: knowledgeSourceChannelId,
          ...(knowledgeSourceThreadTs ? { thread_ts: knowledgeSourceThreadTs } : {}),
          text: notificationText,
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
              text: { type: 'mrkdwn', text: notificationText },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Initial Content:*\n\`\`\`${fileContent.substring(0, 300)}${fileContent.length > 300 ? '...' : ''}\`\`\``,
              },
            },
          ],
          unfurl_links: false,
          unfurl_media: false,
        });

        logger.info(`Sent new file creation notification to channel ${knowledgeSourceChannelId}`);
      } catch (notificationError) {
        logger.warn('Failed to send new file creation notification:', notificationError);
      }
    }

    // Mark document update session as completed
    if (sessionId) {
      try {
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
        if (sessionData) {
          sessionData.status = 'completed_with_new_file';
          sessionData.completedAt = new Date().toISOString();
          sessionData.newFileName = fileName;
          sessionData.newFilePath = filePath;
          storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);
          logger.info(`Marked session ${sessionId} as completed with new file creation`);
        }
      } catch (sessionError) {
        logger.warn('Failed to update session status:', sessionError);
      }
    }

    // 로그 기록
    const workspaceId2 = await getWorkspaceId(client);
    await logModalSubmit(
      userId,
      workspaceId2,
      'create_file_modal',
      Date.now() - startTime,
      true,
      {
        sessionId,
        createFileSessionId,
        fileName,
        filePath,
        fileContent,
        fileContentLength: fileContent.length,
        knowledgeSourceChannelId,
        knowledgeSourceThreadTs,
        owner,
        repo,
        githubPath: path,
        branch: branchName,
        fullGithubUrl: `https://github.com/${owner}/${repo}/blob/${branchName}/${filePath}`,
        fileIndexed: true, // Since we successfully indexed it
        sessionCompleted: !!sessionId,
      },
      client,
      channelId || 'dm',
      'dm',
    );

    logger.info(`Successfully created and indexed file ${fileName} for user ${userId}`);
  } catch (error) {
    logger.error('Error creating file:', error);

    // Parse metadata for error logging
    let metadata: any = {};
    try {
      metadata = JSON.parse(body.view.private_metadata || '{}');
    } catch (parseError) {
      logger.warn('Failed to parse metadata for error logging:', parseError);
    }

    // Show error message if we have channel info
    if (metadata.channelId) {
      try {
        await client.chat.postMessage({
          channel: metadata.channelId,
          text: '❌ File creation failed',
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
              text: {
                type: 'mrkdwn',
                text: `❌ *File creation failed*\n\nSorry, I encountered an error while creating the file: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            },
          ],
        });
      } catch (dmError) {
        logger.error('Failed to send error message:', dmError);
      }
    }

    // 에러 로깅
    try {
      const workspaceId = await getWorkspaceId(client);
      await logModalSubmit(
        metadata.userId || 'unknown',
        workspaceId,
        'create_file_modal',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sessionId: metadata.sessionId,
          fileName: body.view.state.values.file_name_input?.file_name?.value,
          fileContent: body.view.state.values.file_content_input?.file_content?.value,
        },
        client,
        metadata.channelId || 'dm',
        'dm',
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
