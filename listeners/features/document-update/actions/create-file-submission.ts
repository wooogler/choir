import type { AllMiddlewareArgs, SlackViewMiddlewareArgs, ViewSubmitAction } from '@slack/bolt';
import { SessionType, getSessionData, storeSessionData } from 'services/common';
import { logModalSubmit } from 'services/common/interaction-tracker';
import { DocumentUpdateService } from 'services/document/document-update-service';
import { type ProvenanceRecord, buildContextFile, persistContextToMirror } from 'services/document/provenance';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { describeError, tForRequest, tForWorkspace } from 'services/i18n';
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
  context,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  const startTime = Date.now();
  // The progress, validation and result messages are all for the submitter; the
  // announcement further down goes to a whole channel and is resolved there.
  const t = tForRequest(context);
  // Several steps below (metadata parse, session lookup) can throw before the
  // success ack. Without this guard the catch would notify the user but never
  // acknowledge the submission, leaving the modal hung on a Slack error.
  let acked = false;

  try {
    // Parse private metadata
    const metadata = JSON.parse(body.view.private_metadata || '{}');
    const { createFileSessionId, userId, channelId } = metadata;

    // Get data from session store
    const sessionData = getSessionData(createFileSessionId, SessionType.CREATE_FILE_MODAL);
    if (!sessionData) {
      await ack();
      acked = true;
      await client.chat
        .postMessage({
          channel: channelId || userId,
          text: t('docUpdate.actions.createFile.expired'),
        })
        .catch((dmError) => logger.error('Failed to notify expired create-file session:', dmError));
      return;
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
          ...(fileName ? {} : { file_name_input: t('docUpdate.actions.createFile.error.nameRequired') }),
          ...(fileContent ? {} : { file_content_input: t('docUpdate.actions.createFile.error.contentRequired') }),
        },
      });
      acked = true;
      return;
    }

    // Validate file extension
    if (!fileName.endsWith('.md')) {
      await ack({
        response_action: 'errors',
        errors: {
          file_name_input: t('docUpdate.actions.createFile.error.extension'),
        },
      });
      acked = true;
      return;
    }

    // Validate the name, which may now carry a folder: the modal prefills the
    // project folder for a project channel (docs/project-folders.md 4), so
    // `projects/alpha/notes.md` is a legitimate answer. Each segment keeps the
    // old character set, and `.`/`..` are refused so a path can never climb out
    // of the repository.
    const segmentRegex = /^[a-zA-Z0-9._-]+$/;
    const segments = fileName.split('/');
    const validPath = segments.every((segment) => segmentRegex.test(segment) && segment !== '.' && segment !== '..');
    if (!validPath) {
      await ack({
        response_action: 'errors',
        errors: {
          file_name_input: t('docUpdate.actions.createFile.error.invalidName'),
        },
      });
      acked = true;
      return;
    }

    await ack();
    acked = true;

    // Show processing message
    const processingMessage = await client.chat.postMessage({
      channel: channelId,
      text: t('docUpdate.actions.createFile.creating.fallback'),
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.LOADING),
          text: {
            type: 'mrkdwn',
            text: t('docUpdate.actions.createFile.creating', { fileName }),
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
    // `fileName` may carry a folder now, but a MarkdownFile's `name` is its
    // basename everywhere else in the registry, so split the two apart here.
    const baseName = fileName.split('/').pop() || fileName;

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
        text: t('docUpdate.actions.createFile.failed.fallback'),
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: {
              type: 'mrkdwn',
              text: t('docUpdate.actions.createFile.failed.exists', { fileName }),
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
      file: { path: filePath, name: baseName },
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
          name: baseName,
          path: filePath,
          content: createdFile.content,
          githubUrl: `https://github.com/${owner}/${repo}/blob/${branchName}/${filePath}`,
          tree: parseMarkdownToTree(createdFile.content),
        };

        // Register new file in the in-memory file list; QMD index updates on next sync
        await vectorStore.ensureLoaded(workspaceId);
        vectorStore.addToMarkdownFiles(markdownFile, workspaceId);
        logger.info(`Registered new file ${fileName} in markdown file registry`);

        // Update workspace config file list (similar to reload)
        try {
          const { WorkspaceStore } = await import('services/workspace/workspace-store');
          const workspaceStore = new WorkspaceStore();

          // Get current cached file list
          const currentFiles = (await workspaceStore.getMarkdownFilesCache(workspaceId)) || [];

          // Add the new file to the list if not already present
          const fileExists = currentFiles.some((f: { name: string; path: string }) => f.path === filePath);
          if (!fileExists) {
            const updatedFiles = [...currentFiles, { name: baseName, path: filePath }];
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
    const fileUrl = `https://github.com/${owner}/${repo}/blob/${branchName}/${filePath}`;
    const contentPreview = `${fileContent.substring(0, 300)}${fileContent.length > 300 ? '...' : ''}`;
    await updateProcessingMessage({
      text: t('docUpdate.actions.createFile.created.fallback'),
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          text: {
            type: 'mrkdwn',
            text: t('docUpdate.actions.createFile.created', { fileLink: `<${fileUrl}|*${fileName}*>` }),
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('docUpdate.actions.createFile.initialContent', { content: contentPreview }),
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: t('docUpdate.actions.createFile.done'),
          },
        },
      ],
    });

    // Send notification to original channel if available (and different from current DM)
    if (knowledgeSourceChannelId && knowledgeSourceChannelId !== channelId) {
      try {
        // A whole channel reads this one, so it follows the workspace default
        // rather than the submitter's own language.
        const tChannel = await tForWorkspace(workspaceId);

        // Get user name for notification
        const unknownName = tChannel('docUpdate.user.fallbackName');
        let createdBy = unknownName;
        try {
          const userInfo = await client.users.info({ user: userId });
          createdBy = userInfo.user?.real_name || userInfo.user?.name || unknownName;
        } catch (error) {
          logger.warn('Failed to get user info for notification:', error);
        }

        const notificationText = tChannel('docUpdate.actions.createFile.channelNotice', {
          createdBy,
          fileLink: `<${fileUrl}|${fileName}>`,
        });

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
                text: tChannel('docUpdate.actions.createFile.initialContent', { content: contentPreview }),
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

    // Always acknowledge the submission, even on a failure before the success ack,
    // so Slack doesn't leave the modal hanging on a generic connection error.
    if (!acked) {
      await ack().catch((ackError) => logger.error('Failed to ack create-file submission:', ackError));
      acked = true;
    }

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
          text: t('docUpdate.actions.createFile.failed.fallback'),
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
              text: {
                type: 'mrkdwn',
                text: t('docUpdate.actions.createFile.failed.error', {
                  reason: describeError(t, error),
                }),
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
