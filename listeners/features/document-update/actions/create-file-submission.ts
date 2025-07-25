import type { AllMiddlewareArgs, SlackViewMiddlewareArgs, ViewSubmitAction } from '@slack/bolt';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { GithubService } from 'services/github';
import { getWorkspaceId } from 'services/slack';
import { VectorStoreService } from 'services/vector/main-service';
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
    const { sessionId, knowledgeContent, knowledgeSourceChannelId, knowledgeSourceThreadTs, userId, channelId } = metadata;

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
          file_name_input: 'File name contains invalid characters. Use only letters, numbers, dots, hyphens, and underscores.',
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

    // Get workspace configuration
    const workspaceId = await getWorkspaceId(client);
    const workspaceStore = new WorkspaceStore();
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);

    if (!config || !config.githubRepo) {
      throw new Error('Workspace configuration or GitHub repository not found');
    }

    const { owner, repo, path } = config.githubRepo;
    const githubService = GithubService.getInstance();

    // Create the file in GitHub
    const filePath = path ? `${path}/${fileName}` : fileName;
    
    try {
      await githubService.createFile({
        owner,
        repo,
        path: filePath,
        content: fileContent,
        message: `Create ${fileName}`,
        workspaceId,
        userId,
      });

      logger.info(`Successfully created file ${filePath} in GitHub repository ${owner}/${repo}`);
    } catch (githubError: any) {
      // Handle file already exists error
      if (githubError.status === 422 || githubError.message?.includes('already exists')) {
        await client.chat.update({
          channel: channelId,
          ts: processingMessage.ts!,
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
      throw githubError;
    }

    // Reload and index the new file
    const vectorStore = VectorStoreService.getInstance();
    
    try {
      // Get the created file and add it to vector store
      const createdFile = await githubService.getFile({
        owner,
        repo,
        path: filePath,
        workspaceId,
        userId,
      });

      if (createdFile) {
                 // Add to vector store
         await vectorStore.addDocument(filePath, createdFile.content, {
           fileName: fileName,
           nodeId: 'root',
           nodeType: 'root',
           originalContent: createdFile.content,
           githubUrl: `https://github.com/${owner}/${repo}/blob/main/${filePath}`,
         });

        logger.info(`Successfully indexed new file ${fileName} in vector store`);
      }
    } catch (indexError) {
      logger.warn(`Failed to index new file ${fileName}:`, indexError);
      // Continue execution even if indexing fails
    }

    // Update processing message to success
    await client.chat.update({
      channel: channelId,
      ts: processingMessage.ts!,
      text: '✅ File created successfully!',
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
          text: {
            type: 'mrkdwn',
            text: `✅ *File created successfully!*\n\n📄 **${fileName}** has been created in your GitHub repository and is now available for documentation updates.\n\n<https://github.com/${owner}/${repo}/blob/main/${filePath}|View file on GitHub>`,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '🔄 *What\'s next?*\nThe file has been automatically indexed and you can now start your documentation review process.',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Start Review with New File',
                emoji: false,
              },
              style: 'primary',
              action_id: 'start_file_based_review',
              value: JSON.stringify({
                sessionId,
                knowledgeContent,
                knowledgeSourceChannelId,
                knowledgeSourceThreadTs,
                selectedFile: filePath,
                defaultFilePath: filePath,
                isFileBasedReview: true,
              }),
            },
          ],
        },
      ],
    });

    // 로그 기록
    const workspaceId2 = await getWorkspaceId(client);
    await logButtonClick(
      userId,
      workspaceId2,
      channelId || 'dm',
      'dm',
      'create_file_submission',
      Date.now() - startTime,
      true,
      {
        sessionId,
        fileName,
        filePath,
        fileContentLength: fileContent.length,
      },
      client,
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
      await logButtonClick(
        metadata.userId || 'unknown',
        workspaceId,
        metadata.channelId || 'dm',
        'dm',
        'create_file_submission',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sessionId: metadata.sessionId,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
}; 