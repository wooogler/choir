import type {
  AllMiddlewareArgs,
  BlockAction,
  BlockButtonAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  UsersSelectAction,
  ViewSubmitAction,
} from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick, logModalSubmit } from 'services/common/user-interaction-logger';
import { DocumentUpdate, getStoredDocumentUpdates } from 'services/document';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import { GithubService, applyDocumentUpdatesToGithub } from 'services/github';
import { getUserName, parseGithubUrl } from 'services/slack';
import { getWorkspaceId } from 'services/slack';
import { createDocumentUpdateText } from 'services/slack/message-text-utils';
import { VectorStoreService } from 'services/vector/main-service';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

// Store user selection state
const selectedUsers = new Map<string, string>();

/**
 * Handle user selection action
 */
const selectUserCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    // UsersSelect action from value
    const action = body.actions[0] as UsersSelectAction;
    const selectedUser = action.selected_user;

    // No user selected
    if (!selectedUser) {
      logger.error('No user selected in user select action');
      return;
    }

    // Store selected user
    selectedUsers.set(userId, selectedUser);

    logger.info(`User ${userId} selected ${selectedUser} for document update`);
  } catch (error) {
    logger.error('Error handling user selection:', error);
  }
};

export { selectUserCallback };

// Apply changes to GitHub
const applySelectedToGithubAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  let dmResult: any = null;
  let loadingMessage: any = null;

  try {
    const rawValue = body.actions[0].value;
    if (!rawValue) {
      throw new Error('No value provided');
    }

    const value = JSON.parse(rawValue);
    const userId = value.userId || body.user.id;
    const channelId = body.channel?.id;
    const { originalChannelId, originalThreadTs, fileName, githubUrl, sectionName, headingPath, diffBlock } = value;

    if (!channelId) {
      throw new Error('채널 ID를 찾을 수 없습니다');
    }

    // 저장된 모든 document updates 가져오기
    const documentUpdates = getStoredDocumentUpdates(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'No document updates found. Please try suggesting updates first.',
      });
      return;
    }

    console.log(`Found ${documentUpdates.length} document updates for user ${userId}`);

    // 특정 nodeId가 제공된 경우, 해당하는 단일 업데이트만 필터링
    let selectedUpdates = documentUpdates;
    if (value.nodeId) {
      const specificUpdate = documentUpdates.find(update => update.nodeId === value.nodeId);
      if (specificUpdate) {
        selectedUpdates = [specificUpdate];
        console.log(`Filtered to single update for nodeId: ${value.nodeId}`);
      } else {
        console.warn(`No document update found for nodeId: ${value.nodeId}, using all updates as fallback`);
      }
    }

    // DM 채널 열기
    dmResult = await client.conversations.open({
      users: userId,
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error('Failed to open DM channel');
    }

    // 로딩 메시지 먼저 보내기
    loadingMessage = await client.chat.postMessage({
      channel: dmResult.channel.id,
      text: "⚙️ Applying changes to GitHub...",
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
          text: {
            type: 'mrkdwn',
            text: "⚙️ Applying changes to GitHub...",
          },
        },
      ],
    });

    // GitHub에 문서 업데이트 적용
    const results = await applyDocumentUpdatesToGithub({
      userId,
      documentUpdates: selectedUpdates,
      client,
    });

    // 결과 분석
    const successfulUpdates = results.filter((r) => r.success);
    const failedUpdates = results.filter((r) => !r.success).map((r) => r.fileName);

    // 결과 메시지 생성 - CHOIR 페르소나 적용 및 githubUrl 수정
    let resultMessage = "I've finished processing the document updates!"; // 기본 메시지
    if (successfulUpdates.length > 0) {
      const successfulUpdate = successfulUpdates[0]; // 단일 파일 처리 가정
      const fileName = successfulUpdate.fileName;
      const commitSha = successfulUpdate.commitSha;
      
      // documentUpdates에서 실제 githubUrl 가져오기
      const actualGithubUrl = selectedUpdates.find(u => u.fileName === fileName)?.githubUrl || githubUrl;
      
      // Generate URLs for the updated file
      const workspaceId = await getWorkspaceId(client);
      const workspaceStore = new (await import('services/workspace/workspace-store')).WorkspaceStore();
      const config = await workspaceStore.getWorkspaceConfig(workspaceId);
      let editUrl = '';
      let commitDiffUrl = '';
      
      if (config?.githubRepo && fileName) {
        const { owner, repo, branch } = config.githubRepo;
        const branchName = branch || 'main';
        // Find the file path from selected updates
        const updateWithPath = selectedUpdates.find(u => u.fileName === fileName);
        if (updateWithPath) {
          // Extract file path from github URL or use fileName directly
          const filePath = updateWithPath.githubUrl?.split('/blob/')[1]?.split('/').slice(1).join('/') || fileName;
          editUrl = `https://github.com/${owner}/${repo}/edit/${branchName}/${filePath}`;
          
          // Generate commit diff URL if we have commitSha
          if (commitSha) {
            commitDiffUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`;
          }
        }
      }
      
      resultMessage = `✅ Great news! I've successfully updated the document: <${actualGithubUrl}|*${fileName}*>`;
      if (commitDiffUrl && editUrl) {
        resultMessage += `\n\n📝 You can <${commitDiffUrl}|view the changes> or <${editUrl}|edit the file> directly on GitHub.`;
      } else if (editUrl) {
        resultMessage += `\n\n📝 You can <${editUrl}|edit the file> directly on GitHub.`;
      }
    }
    if (failedUpdates.length > 0) {
      const fileName = failedUpdates[0]; // 단일 파일 처리 가정
      if (successfulUpdates.length > 0) {
        resultMessage += `\nHowever, I ran into a little trouble updating *${fileName}*. You might want to check that one manually.`;
      } else {
        resultMessage = `Hm, it looks like I couldn't update *${fileName}*. 😕 You might need to take a look and see what went wrong.`;
      }
    }

    // 로딩 메시지를 완료 메시지로 업데이트
    if (loadingMessage.ok && loadingMessage.ts) {
      await client.chat.update({
        channel: dmResult.channel.id,
        ts: loadingMessage.ts,
        text: resultMessage || "Document update process completed! If there were any issues, I've noted them above.",
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.SUCCESS),
            text: {
              type: 'mrkdwn',
              text:
                resultMessage || "Document update process completed! If there were any issues, I've noted them above.",
            },
          },
        ],
      });

      // 성공한 경우 원본 채널에도 업데이트 내용 공유 - CHOIR 페르소나 적용
      if (successfulUpdates.length > 0 && originalChannelId && diffBlock) {
        try {
          const updatedFileName = successfulUpdates[0].fileName; // 성공한 파일 이름 사용
          const userName = await getUserName(userId, client); // 사용자 이름 가져오기
          // 실제 githubUrl 사용
          const actualGithubUrl = selectedUpdates.find(u => u.fileName === updatedFileName)?.githubUrl || githubUrl;
          const sectionInfo = formatSectionPathWithLinks({
            headingPath,
            sectionName,
            githubUrl: actualGithubUrl,
          } as any);

          const channelUpdateText = `🎉 Good news, everyone! *${userName}* just helped me update a document!\\n\\n*File:* <${actualGithubUrl}|${updatedFileName}>\\n*Section:* ${sectionInfo}\\n\\nI've incorporated the latest insights. Teamwork makes the dream work! ✨`;

          const updateBlocks = [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: channelUpdateText,
              },
            },
            diffBlock, // 기존 diffBlock 사용
          ];

          // Extract diff content for comprehensive text - pass the actual diffBlock object
          const diffContent = diffBlock || null;

          // Create comprehensive text using helper function
          const comprehensiveText = createDocumentUpdateText(
            updatedFileName,
            userName,
            sectionInfo,
            actualGithubUrl,
            diffContent,
            [
              { text: 'View Changes', style: 'primary' },
              { text: 'View File', url: actualGithubUrl },
            ],
          );

          await client.chat.postMessage({
            channel: originalChannelId,
            ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
            text: comprehensiveText,
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
                text: { type: 'mrkdwn', text: channelUpdateText },
              },
              ...updateBlocks.slice(1),
            ],
            unfurl_links: false,
            unfurl_media: false,
          });
        } catch (channelError) {
          console.error('Failed to post update to original channel:', channelError);
          // 실패해도 DM은 전송되었으므로 계속 진행
        }
      }
    } else {
      console.error('Failed to update loading message');
    }

    // 로그: GitHub 업데이트 성공
    const workspaceId = await getWorkspaceId(client);
    await logButtonClick(
      userId,
      workspaceId,
      channelId,
      'dm',
      'apply_to_document',
      Date.now() - startTime,
      true,
      {
        successfulUpdates,
        failedUpdates,
        totalUpdates: selectedUpdates.length,
        originalChannelId,
        originalThreadTs,
        fileName: successfulUpdates[0]?.fileName || failedUpdates[0],
      },
      client,
    );

    console.log(
      `Document updates applied to GitHub for user ${userId}: ${successfulUpdates.length} successful, ${failedUpdates.length} failed`,
    );
  } catch (error) {
    console.error('Error applying updates to GitHub:', error);

    // 로그: GitHub 업데이트 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      const value = body.actions?.[0]?.value;
      const parsedValue = value ? JSON.parse(value) : {};

      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || 'dm',
        'dm',
        'apply_to_document',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          userId: parsedValue?.userId || body.user.id,
          originalChannelId: parsedValue?.originalChannelId,
          originalThreadTs: parsedValue?.originalThreadTs,
        },
        client,
      );
    } catch (logError) {
      console.error('Failed to log button click error:', logError);
    }

    // 에러 메시지를 DM으로 전송 - 기존 채널 사용
    try {
      const errorMessage = `😥 Oops! It seems I ran into a problem while trying to update the document on GitHub. \\nError: ${error instanceof Error ? error.message : 'Unknown error'}\\n\\nCould you please check the details or try again? If the problem persists, an administrator might need to look into it.`;
      
      // 이미 연 DM 채널이 있으면 재사용, 없으면 새로 열기
      let targetChannelId: string | undefined;
      
      if (dmResult?.ok && dmResult.channel?.id) {
        targetChannelId = dmResult.channel.id;
        
        // 로딩 메시지가 있으면 업데이트, 없으면 새 메시지
        if (loadingMessage?.ok && loadingMessage.ts) {
          await client.chat.update({
            channel: targetChannelId!,
            ts: loadingMessage.ts,
            text: errorMessage,
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
                text: {
                  type: 'mrkdwn',
                  text: errorMessage,
                },
              },
            ],
          });
        } else {
          await client.chat.postMessage({
            channel: targetChannelId!,
            text: errorMessage,
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
                text: {
                  type: 'mrkdwn',
                  text: errorMessage,
                },
              },
            ],
          });
        }
      } else {
        // DM 채널을 새로 열기
        const newDmResult = await client.conversations.open({
          users: body.user.id,
        });
        
        if (newDmResult.ok && newDmResult.channel?.id) {
          await client.chat.postMessage({
            channel: newDmResult.channel.id,
            text: errorMessage,
            blocks: [
              {
                type: 'section',
                block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
                text: {
                  type: 'mrkdwn',
                  text: errorMessage,
                },
              },
            ],
          });
        }
      }
    } catch (dmError) {
      console.error('Failed to send error message to DM:', dmError);
    }
  }
};

export { applySelectedToGithubAction };

/**
 * New section modal submission handler - GitHub update version
 */
export const handleNewSectionModalSubmission = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const { user } = body;
    const { values } = body.view.state;

    // Extract form values
    const sectionTitle = values.section_title_input?.section_title?.value || '';
    const sectionBody = values.section_body_input?.section_body?.value || '';
    const selectedFile = values.file_selection_input?.file_selection?.selected_option?.value || '';

    // Extract metadata
    const metadata = JSON.parse(body.view.private_metadata || '{}');
    const {
      recommendedFile,
      userId,
      editUrl,
      sessionId,
      buttonMessageTs,
      buttonChannelId,
      originalChannelId,
      originalThreadTs,
    } = metadata;

    // Use selected file if available, otherwise fall back to recommended file
    const targetFile = selectedFile || recommendedFile;

    logger.info(`New section modal submitted by user ${user.id}`);
    logger.info(`Section title: ${sectionTitle}`);
    logger.info(`Section body length: ${sectionBody.length}`);
    logger.info(`Recommended file: ${recommendedFile}`);

    if (!sectionTitle || !sectionBody) {
      await client.chat.postMessage({
        channel: user.id,
        text: '❌ Section title and body are required.',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: '❌ Section title and body are required.' },
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
        text: '❌ No target file found. Please try again.',
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: '❌ No target file found. Please try again.' },
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

    // 1. 벡터 스토어에 새 섹션 추가
    const success = await vectorStore.addNewSection(targetFile, sectionTitle, sectionBody);

    if (!success) {
      await client.chat.postMessage({
        channel: user.id,
        text: `❌ Failed to add new section to vector store for file: ${targetFile}`,
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: `❌ Failed to add new section to vector store for file: ${targetFile}` },
          },
        ],
      });

      // 로그: 벡터 스토어 추가 실패
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        user.id,
        workspaceId,
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
    const markdownFile = vectorStore.getMarkdownFile(targetFile);
    if (!markdownFile) {
      await client.chat.postMessage({
        channel: user.id,
        text: `❌ Updated markdown file not found: ${targetFile}`,
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: `❌ Updated markdown file not found: ${targetFile}` },
          },
        ],
      });

      // 로그: 마크다운 파일 없음
      const workspaceId = await getWorkspaceId(client);
      logModalSubmit(
        user.id,
        workspaceId,
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
        text: `❌ Invalid GitHub URL: ${githubUrl}`,
        blocks: [
          {
            type: 'section',
            block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
            text: { type: 'mrkdwn', text: `❌ Invalid GitHub URL: ${githubUrl}` },
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
    });

    // 7. Skip DM success message - will be shown in updated message instead

    // 8. Update the original message to show completion
    try {
      // Generate URLs for the new section
      const editUrl = `https://github.com/${owner}/${repo}/edit/main/${markdownFile.path}`;
      const commitDiffUrl = updateResult.commitSha ? `https://github.com/${owner}/${repo}/commit/${updateResult.commitSha}` : '';
      
      // Use the same UI format as the success message (lines 448-458)
      let successText = `✅ New section "${sectionTitle}" added successfully to GitHub!

📁 *File:* <${githubUrl}|${targetFile}>
📝 *Added by:* ${userName}`;
      
      // Add URL options if available
      if (commitDiffUrl && editUrl) {
        successText += `\n\n📝 You can <${commitDiffUrl}|view the changes> or <${editUrl}|edit the file> directly on GitHub.`;
      } else if (editUrl) {
        successText += `\n\n📝 You can <${editUrl}|edit the file> directly on GitHub.`;
      }
      
      successText += `\n\n🔍 *Preview:*
\`\`\`# ${sectionTitle}
${sectionBody.substring(0, 200)}${sectionBody.length > 200 ? '...' : ''}\`\`\``;

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

        logger.info(`Updated button message after successful section creation`);
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

          logger.info(`Updated main message after successful section creation`);
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

          logger.info(`Updated empty vector store message after successful section creation`);
        }
      }
    } catch (updateError) {
      logger.warn(`Failed to update original message: ${updateError}`);
    }

    // 9. Post success message to original channel (similar to document updates)
    if (originalChannelId) {
      try {
        const channelUpdateText = `🎉 Good news, everyone! *${userName}* just added a new section to our documentation!

📁 *File:* <${githubUrl}|${targetFile}>
📝 *Section:* ${sectionTitle}

I've added the new content. Knowledge grows stronger! ✨`;

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
              text: `🔍 *Preview of new section:*\n\`\`\`# ${sectionTitle}\n${sectionBody.substring(0, 200)}${sectionBody.length > 200 ? '...' : ''}\`\`\``,
            },
          },
        ];

        await client.chat.postMessage({
          channel: originalChannelId,
          ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
          text: `✅ New Section Added: ${sectionTitle} in ${targetFile} by *${userName}* (with CHOIR)`,
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
        sectionTitle,
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

    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to process new section submission: ${error instanceof Error ? error.message : 'Unknown error'}`,
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.ERROR),
          text: {
            type: 'mrkdwn',
            text: `❌ Failed to process new section submission: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        },
      ],
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
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
