import type { AllMiddlewareArgs, SlackViewMiddlewareArgs, ViewSubmitAction } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logModalSubmit } from 'services/common/interaction-tracker';
import { VectorStoreService } from 'services/file-registry/main-service';
import { GithubService } from 'services/github';
import { tForRequest, tForWorkspace } from 'services/i18n';
import { getUserName, getWorkspaceId, parseGithubUrl } from 'services/slack';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

/**
 * New section modal submission handler - GitHub update version
 */
export const handleNewSectionModalSubmission = async ({
  ack,
  body,
  client,
  context,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  const startTime = Date.now();
  await ack();

  // Refusals and the rewritten success card are read by the submitter; the
  // channel announcement near the end is resolved for the channel instead.
  const t = tForRequest(context);

  try {
    const { user } = body;
    const { values } = body.view.state;

    // Extract form values
    const sectionTitle = values.section_title_input?.section_title?.value || '';
    const sectionBody = values.section_body_input?.section_body?.value || '';
    const selectedFile = values.file_selection_input?.file_selection?.selected_option?.value || '';

    // Extract metadata from session store instead of private_metadata
    const modalSessionId = body.view.private_metadata || '';
    const sessionData = getSessionData(modalSessionId, SessionType.NEW_SECTION);

    if (!sessionData) {
      throw new Error('Modal session data not found');
    }

    const {
      recommendedFile,
      userId,
      recommendedFileEditUrl: editUrl,
      sessionId,
      buttonMessageTs,
      buttonChannelId,
      originalChannelId,
      originalThreadTs,
      branch: sessionBranch,
    } = sessionData;

    // Use selected file if available, otherwise fall back to recommended file
    const targetFile = selectedFile || recommendedFile;

    // Get current DM channel ID for consistency with other similar functions
    const currentDmChannelId = user.id;

    logger.info(`New section modal submitted by user ${user.id}`);
    logger.info(`Section title: "${sectionTitle}"`);
    logger.info(`Section body: "${sectionBody}"`);
    logger.info(`Section body length: ${sectionBody.length}`);
    logger.info(`Recommended file: ${recommendedFile}`);

    // 디버깅: 모달 values 전체 구조 확인
    logger.info('Modal values structure:', JSON.stringify(values, null, 2));

    if (!sectionTitle || !sectionBody) {
      await client.chat.postMessage({
        channel: user.id,
        text: t('docUpdate.apply.newSection.error.missingFields'),
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: t('docUpdate.apply.newSection.error.missingFields') },
          },
        ],
      });

      // 로그: 필수 필드 누락
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        user.id,
        workspaceId,
        'new_section_modal',
        Date.now() - startTime,
        false,
        {
          error: 'Missing section title or body',
          sectionTitle: !!sectionTitle,
          sectionBody: !!sectionBody,
          targetFile,
        },
        client,
        originalChannelId || 'dm',
        originalChannelId ? 'public' : 'dm',
      );
      return;
    }

    if (!targetFile) {
      await client.chat.postMessage({
        channel: user.id,
        text: t('docUpdate.apply.newSection.error.noTargetFile'),
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: t('docUpdate.apply.newSection.error.noTargetFile') },
          },
        ],
      });

      // 로그: 대상 파일 없음
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        user.id,
        workspaceId,
        'new_section_modal',
        Date.now() - startTime,
        false,
        {
          error: 'No target file found',
          sectionTitle,
          sectionBodyLength: sectionBody.length,
        },
        client,
        originalChannelId || 'dm',
        originalChannelId ? 'public' : 'dm',
      );
      return;
    }

    // 벡터 스토어 인스턴스 가져오기
    const vectorStore = VectorStoreService.getInstance();
    const currentWorkspaceId = await getWorkspaceId(client);

    // 1. 벡터 스토어에 새 섹션 추가
    const success = await vectorStore.addNewSection(targetFile, sectionTitle, sectionBody, currentWorkspaceId);

    if (!success) {
      await client.chat.postMessage({
        channel: user.id,
        text: t('docUpdate.apply.newSection.error.vectorStore', { fileName: targetFile }),
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: t('docUpdate.apply.newSection.error.vectorStore', { fileName: targetFile }) },
          },
        ],
      });

      // 로그: 벡터 스토어 추가 실패
      logModalSubmit(
        user.id,
        currentWorkspaceId,
        'new_section_modal',
        Date.now() - startTime,
        false,
        {
          error: 'Failed to add new section to vector store',
          targetFile,
          sectionTitle,
          sectionBodyLength: sectionBody.length,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    // 2. 업데이트된 마크다운 파일 가져오기
    const markdownFile = vectorStore.getMarkdownFile(targetFile, currentWorkspaceId);
    if (!markdownFile) {
      await client.chat.postMessage({
        channel: user.id,
        text: t('docUpdate.apply.newSection.error.fileNotFound', { fileName: targetFile }),
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: {
              type: 'mrkdwn',
              text: t('docUpdate.apply.newSection.error.fileNotFound', { fileName: targetFile }),
            },
          },
        ],
      });

      // 로그: 마크다운 파일 없음
      logModalSubmit(
        user.id,
        currentWorkspaceId,
        'new_section_modal',
        Date.now() - startTime,
        false,
        {
          error: 'Updated markdown file not found',
          targetFile,
          sectionTitle,
          sectionBodyLength: sectionBody.length,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    // 3. 트리를 마크다운으로 변환
    const { treeToMarkdown } = await import('services/document/markdown');
    const updatedMarkdown = treeToMarkdown(markdownFile.tree);

    // 4. GitHub URL 파싱
    const githubUrl = markdownFile.githubUrl;
    const parsedUrl = parseGithubUrl(githubUrl);
    if (!parsedUrl) {
      await client.chat.postMessage({
        channel: user.id,
        text: t('docUpdate.apply.newSection.error.invalidUrl', { githubUrl }),
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: t('docUpdate.apply.newSection.error.invalidUrl', { githubUrl }) },
          },
        ],
      });

      // 로그: GitHub URL 파싱 실패
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        user.id,
        workspaceId,
        'new_section_modal',
        Date.now() - startTime,
        false,
        {
          error: 'Invalid GitHub URL',
          githubUrl,
          targetFile,
          sectionTitle,
          sectionBodyLength: sectionBody.length,
        },
        client,
        'modal',
        'dm',
      );
      return;
    }

    const { owner, repo } = parsedUrl;
    const branchMatch = githubUrl.match(/\/blob\/([^/]+)\//);
    const branchName =
      sessionBranch ||
      branchMatch?.[1] ||
      (await GithubService.getInstance().getDefaultBranch(owner, repo, currentWorkspaceId, userId));

    // 5. 커밋 메시지 생성
    const userName = await getUserName(userId, client);
    const commitMessage = `Add new section: ${sectionTitle}

Added by: ${userName}
File: ${targetFile}
Content: ${sectionBody.substring(0, 100)}${sectionBody.length > 100 ? '...' : ''}`;

    // 6. GitHub에 파일 업데이트
    const githubService = GithubService.getInstance();
    const updateResult = await githubService.updateMarkdownFile({
      owner,
      repo,
      path: markdownFile.path, // 실제 파일 경로 사용
      content: updatedMarkdown,
      message: commitMessage,
      branch: branchName,
      workspaceId: currentWorkspaceId,
      userId,
    });

    // 6b. Keep the in-memory vector-store copy, the workspace mirror, and the
    // sync-state consistent with what we just committed. addNewSection only
    // mutated file.tree; without also refreshing file.content and the mirror, a
    // later anchor-based apply would use the pre-section content as its full-file
    // base and silently delete this new section from GitHub.
    markdownFile.content = updatedMarkdown;
    try {
      const { DocumentUpdateService } = await import('services/document/document-update-service');
      const documentUpdateService = DocumentUpdateService.getInstance();
      await documentUpdateService.stageMarkdownUpdate({
        workspaceId: currentWorkspaceId,
        filePath: markdownFile.path,
        content: updatedMarkdown,
        owner,
        repo,
        branch: branchName,
      });
      await documentUpdateService.markGithubSyncSuccess({
        workspaceId: currentWorkspaceId,
        filePath: markdownFile.path,
        owner,
        repo,
        branch: branchName,
        commitSha: updateResult.commitSha,
      });
    } catch (syncError) {
      // Non-fatal: the GitHub commit already landed. The mirror will re-sync on
      // the next full reload; don't fail the action over a local staging error.
      console.error('Failed to sync new section to workspace mirror:', syncError);
    }

    // 7. Skip DM success message - will be shown in updated message instead

    // 8. Update the original message to show completion
    try {
      // Generate URLs for the new section
      const editUrl = `https://github.com/${owner}/${repo}/edit/${branchName}/${markdownFile.path}`;
      const commitDiffUrl = updateResult.commitSha
        ? `https://github.com/${owner}/${repo}/commit/${updateResult.commitSha}`
        : '';

      // One sentence per slot instead of a `+=` chain, so a translator can
      // reorder the links and the preview without touching this handler.
      let successText = t('docUpdate.apply.newSection.success', {
        sectionTitle,
        fileLink: `<${githubUrl}|${targetFile}>`,
        userName,
      });

      // Add URL options if available
      const viewLink = commitDiffUrl ? `<${commitDiffUrl}|${t('docUpdate.apply.link.viewChanges')}>` : '';
      const editLinkText = editUrl ? `<${editUrl}|${t('docUpdate.apply.link.editFile')}>` : '';
      if (viewLink && editLinkText) {
        successText += t('docUpdate.apply.links', {
          links: t('docUpdate.apply.links.pair', { viewLink, editLink: editLinkText }),
        });
      } else if (editLinkText) {
        successText += t('docUpdate.apply.links', { links: editLinkText });
      }

      const sectionPreview = `${sectionBody.substring(0, 200)}${sectionBody.length > 200 ? '...' : ''}`;
      successText += t('docUpdate.apply.newSection.preview', { sectionTitle, sectionBody: sectionPreview });

      // First try to update the button message directly (for cases where we have button info)
      if (buttonMessageTs && buttonChannelId) {
        await client.chat.update({
          channel: buttonChannelId,
          ts: buttonMessageTs,
          text: successText,
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
              text: { type: 'mrkdwn', text: successText },
            },
          ],
        });

        logger.info('Updated button message after successful section creation');
      }
      // Check for main message from integrated UI
      else if (sessionId) {
        const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;

        // Check for main message (integrated UI)
        if (sessionData?.mainMessageTs && sessionData?.mainChannelId) {
          await client.chat.update({
            channel: sessionData.mainChannelId,
            ts: sessionData.mainMessageTs,
            text: successText,
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
                text: { type: 'mrkdwn', text: successText },
              },
            ],
          });

          logger.info('Updated main message after successful section creation');
        }
        // Check for empty vector store message
        else if (sessionData?.emptyVectorStoreMessageTs && sessionData?.emptyVectorStoreChannelId) {
          await client.chat.update({
            channel: sessionData.emptyVectorStoreChannelId,
            ts: sessionData.emptyVectorStoreMessageTs,
            text: successText,
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
                text: { type: 'mrkdwn', text: successText },
              },
            ],
          });

          logger.info('Updated empty vector store message after successful section creation');
        }
      }
    } catch (updateError) {
      logger.warn(`Failed to update original message: ${updateError}`);
    }

    // 9. Post success message to original channel (similar to document updates)
    // Only notify if original channel is different from current DM
    if (originalChannelId && originalChannelId !== currentDmChannelId) {
      try {
        // A channel post has no single reader, so it follows the workspace's
        // language rather than the submitter's.
        const tChannel = await tForWorkspace(currentWorkspaceId);
        const channelPreview = `${sectionBody.substring(0, 200)}${sectionBody.length > 200 ? '...' : ''}`;
        const channelUpdateText = tChannel('docUpdate.apply.newSection.channel', {
          userName,
          fileLink: `<${githubUrl}|${targetFile}>`,
          sectionTitle,
        });

        const updateBlocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: channelUpdateText,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: tChannel('docUpdate.apply.newSection.channel.preview', {
                sectionTitle,
                sectionBody: channelPreview,
              }),
            },
          },
        ];

        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: tChannel('docUpdate.apply.newSection.channel.fallback', {
            sectionTitle,
            fileName: targetFile,
            userName,
          }),
          blocks: [
            {
              type: 'section',
              block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
              text: { type: 'mrkdwn', text: channelUpdateText },
            },
            ...updateBlocks.slice(1),
          ],
          unfurl_links: false,
          unfurl_media: false,
        });

        logger.info(`Posted new section success message to original channel: ${originalChannelId}`);
      } catch (channelError) {
        logger.error('Failed to post new section update to original channel:', channelError);
        // Continue execution even if channel posting fails
      }
    }

    logger.info(`Successfully created new section "${sectionTitle}" for ${recommendedFile} and pushed to GitHub`);

    // 로그: 성공
    const workspaceId = await getWorkspaceId(client);
    logModalSubmit(
      user.id,
      workspaceId,
      'new_section_modal',
      Date.now() - startTime,
      true,
      {
        recommendedFile,
        selectedFile,
        targetFile,
        sectionTitle,
        sectionBody,
        sectionBodyLength: sectionBody.length,
        githubUrl,
        owner,
        repo,
        commitMessageLength: commitMessage.length,
        updatedMarkdownLength: updatedMarkdown.length,
      },
      client,
      originalChannelId || 'dm',
      originalChannelId ? 'public' : 'dm',
    );
  } catch (error) {
    logger.error('Error handling new section modal submission:', error);

    const submitErrorText = t('docUpdate.apply.newSection.error.submit', {
      reason: error instanceof Error ? error.message : 'Unknown error',
    });
    await client.chat.postMessage({
      channel: body.user.id,
      text: submitErrorText,
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          text: {
            type: 'mrkdwn',
            text: submitErrorText,
          },
        },
      ],
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      // Extract form values for error logging
      const errorSectionTitle = body.view.state.values.section_title_input?.section_title?.value || '';
      const errorSectionBody = body.view.state.values.section_body_input?.section_body?.value || '';
      const errorSelectedFile =
        body.view.state.values.file_selection_input?.file_selection?.selected_option?.value || '';

      // Extract originalChannelId from metadata for error logging
      const errorMetadata = JSON.parse(body.view.private_metadata || '{}');
      const errorOriginalChannelId = errorMetadata.originalChannelId;

      logModalSubmit(
        body.user.id,
        workspaceId,
        'new_section_modal',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          sectionTitle: errorSectionTitle,
          sectionBody: errorSectionBody,
          selectedFile: errorSelectedFile,
          privateMetadata: body.view.private_metadata,
        },
        client,
        errorOriginalChannelId || 'dm',
        errorOriginalChannelId ? 'public' : 'dm',
      );
    } catch (logError) {
      logger.error('Failed to log error:', logError);
    }
  }
};
