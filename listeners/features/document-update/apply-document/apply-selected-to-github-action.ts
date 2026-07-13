import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { logButtonClick } from 'services/common/interaction-tracker';
import { getStoredDocumentUpdates } from 'services/document';
import { formatSectionPathWithLinks } from 'services/document/section-utils';
import { GithubService, applyDocumentUpdatesToGithub } from 'services/github';
import { getUserName, getWorkspaceId } from 'services/slack';
import { createDocumentUpdateText } from 'services/slack/message-text-utils';
import { CHOIRMessageType, createCHOIRBlockId } from 'types/message-types';

export interface ApplyToGithubResult {
  success: boolean;
  successfulFileNames: string[];
  failedFileNames: string[];
}

// Apply changes to GitHub
export const applySelectedToGithubAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>): Promise<ApplyToGithubResult> => {
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

    const workspaceId = await getWorkspaceId(client);

    // 저장된 모든 document updates 가져오기
    const documentUpdates = getStoredDocumentUpdates(userId, workspaceId);

    if (!documentUpdates || documentUpdates.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'No document updates found. Please try suggesting updates first.',
      });
      return { success: false, successfulFileNames: [], failedFileNames: [] };
    }

    console.log(`Found ${documentUpdates.length} document updates for user ${userId}`);

    // 특정 nodeId가 제공된 경우, 해당하는 단일 업데이트만 필터링
    let selectedUpdates = documentUpdates;
    if (value.nodeId) {
      const specificUpdate = documentUpdates.find((update) => update.nodeId === value.nodeId);
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
      text: '⚙️ Applying changes to GitHub...',
      blocks: [
        {
          type: 'section',
          block_id: createCHOIRBlockId(CHOIRMessageType.NOTIFICATION),
          text: {
            type: 'mrkdwn',
            text: '⚙️ Applying changes to GitHub...',
          },
        },
      ],
    });

    // GitHub에 문서 업데이트 적용
    const results = await applyDocumentUpdatesToGithub({
      userId,
      documentUpdates: selectedUpdates,
      client,
      workspaceId,
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
      const actualGithubUrl = selectedUpdates.find((u) => u.fileName === fileName)?.githubUrl || githubUrl;

      // Generate URLs for the updated file
      const workspaceStore = new (await import('services/workspace/workspace-store')).WorkspaceStore();
      const config = await workspaceStore.getWorkspaceConfig(workspaceId);
      let editUrl = '';
      let commitDiffUrl = '';

      if (config?.githubRepo && fileName) {
        const { owner, repo, branch } = config.githubRepo;
        const branchName =
          branch || (await GithubService.getInstance().getDefaultBranch(owner, repo, workspaceId, userId));
        // Find the file path from selected updates
        const updateWithPath = selectedUpdates.find((u) => u.fileName === fileName);
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
          const actualGithubUrl = selectedUpdates.find((u) => u.fileName === updatedFileName)?.githubUrl || githubUrl;
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

    // Extract original and applied content from selectedUpdates
    const firstUpdate = selectedUpdates[0];
    const originalContent = firstUpdate?.oldContent || '';
    const appliedContent = firstUpdate?.newContent || '';

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
        originalContent,
        appliedContent,
        originalContentLength: originalContent.length,
        appliedContentLength: appliedContent.length,
      },
      client,
    );

    console.log(
      `Document updates applied to GitHub for user ${userId}: ${successfulUpdates.length} successful, ${failedUpdates.length} failed`,
    );

    return {
      success: failedUpdates.length === 0 && successfulUpdates.length > 0,
      successfulFileNames: successfulUpdates.map((u) => u.fileName),
      failedFileNames: failedUpdates,
    };
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
          fileName: parsedValue?.fileName,
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
      if (dmResult?.ok && dmResult.channel?.id) {
        const targetChannel = dmResult.channel.id;

        // 로딩 메시지가 있으면 업데이트, 없으면 새 메시지
        if (loadingMessage?.ok && loadingMessage.ts) {
          await client.chat.update({
            channel: targetChannel,
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
            channel: targetChannel,
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

    return { success: false, successfulFileNames: [], failedFileNames: [] };
  }
};
