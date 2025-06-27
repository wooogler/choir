import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
  BlockAction,
  UsersSelectAction,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from "@slack/bolt";
import { DocumentUpdate, getStoredDocumentUpdates, getSelectedNodeIds } from "services/document";
import { VectorStoreService } from "services/vector/main-service";
import GithubService from "services/github";
import { parseGithubUrl, getUserName } from "services/slack";
import { applyDocumentUpdatesToGithub } from "services/github";
import { formatSectionPathWithLinks } from "services/document/section-utils";

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
      logger.error("No user selected in user select action");
      return;
    }

    // Store selected user
    selectedUsers.set(userId, selectedUser);

    logger.info(`User ${userId} selected ${selectedUser} for document update`);
  } catch (error) {
    logger.error("Error handling user selection:", error);
  }
};

export { selectUserCallback };



// Apply changes to GitHub
const applySelectedToGithubAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    if (!rawValue) {
      throw new Error("No value provided");
    }

    const value = JSON.parse(rawValue);
    const userId = value.userId || body.user.id;
    const channelId = body.channel?.id;
    const { originalChannelId, originalThreadTs, fileName, githubUrl, sectionName, headingPath, diffBlock } = value;

    if (!channelId) {
      throw new Error("채널 ID를 찾을 수 없습니다");
    }

    // 저장된 모든 document updates 가져오기 (더 이상 selectedNodeIds 필요 없음)
    const documentUpdates = getStoredDocumentUpdates(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No document updates found. Please try suggesting updates first.",
      });
      return;
    }

    console.log(`Found ${documentUpdates.length} document updates for user ${userId}`);

    // 모든 업데이트 사용 (선택된 노드 필터링 제거)
    const selectedUpdates = documentUpdates;

    // GitHub에 문서 업데이트 적용
    const results = await applyDocumentUpdatesToGithub({
      userId,
      documentUpdates: selectedUpdates,
      client,
    });

    // 결과 분석
    const successfulUpdates = results.filter(r => r.success).map(r => r.fileName);
    const failedUpdates = results.filter(r => !r.success).map(r => r.fileName);

    // DM 채널 열기
    const dmResult = await client.conversations.open({
      users: userId
    });

    if (dmResult.ok && dmResult.channel?.id) {
      // 결과 메시지 생성 - CHOIR 페르소나 적용
      let resultMessage = "I've finished processing the document updates!"; // 기본 메시지
      if (successfulUpdates.length > 0) {
        const fileName = successfulUpdates[0]; // 단일 파일 처리 가정
        resultMessage = `✅ Great news! I've successfully updated the document: *${fileName}*`;
      }
      if (failedUpdates.length > 0) {
        const fileName = failedUpdates[0]; // 단일 파일 처리 가정
        if (successfulUpdates.length > 0) {
          resultMessage += `\nHowever, I ran into a little trouble updating *${fileName}*. You might want to check that one manually.`;
        } else {
          resultMessage = `Hm, it looks like I couldn't update *${fileName}*. 😕 You might need to take a look and see what went wrong.`;
        }
      }

      // DM으로 결과 메시지 전송
      await client.chat.postMessage({
        channel: dmResult.channel.id,
        text: resultMessage || "Document update process completed! If there were any issues, I've noted them above.",
      });

      // 성공한 경우 원본 채널에도 업데이트 내용 공유 - CHOIR 페르소나 적용
      if (successfulUpdates.length > 0 && originalChannelId && diffBlock) {
        try {
          const updatedFileName = successfulUpdates[0]; // 성공한 파일 이름 사용
          const userName = await getUserName(userId, client); // 사용자 이름 가져오기
          const sectionInfo = formatSectionPathWithLinks({
            headingPath,
            sectionName,
            githubUrl
          } as any);

          const channelUpdateText = `🎉 Good news, everyone! *${userName}* just helped me update a document!\\n\\n*File:* <${githubUrl}|${updatedFileName}>\\n*Section:* ${sectionInfo}\\n\\nI've incorporated the latest insights. Teamwork makes the dream work! ✨`;

          const updateBlocks = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: channelUpdateText
              }
            },
            diffBlock // 기존 diffBlock 사용
          ];

          await client.chat.postMessage({
            channel: originalChannelId,
            ...(originalThreadTs ? { thread_ts: originalThreadTs } : {}),
            text: `✅ Document Updated: ${updatedFileName} by *${userName}* (with CHOIR)`, // 볼드체 적용
            blocks: updateBlocks,
            unfurl_links: false,
            unfurl_media: false
          });
        } catch (channelError) {
          console.error("Failed to post update to original channel:", channelError);
          // 실패해도 DM은 전송되었으므로 계속 진행
        }
      }
    }
  } catch (error) {
    console.error("Error applying updates to GitHub:", error);

    // DM 채널 열기 - CHOIR 페르소나 적용
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });
      
      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `😥 Oops! It seems I ran into a problem while trying to update the document on GitHub. \\nError: ${error instanceof Error ? error.message : "Unknown error"}\\n\\nCould you please check the details or try again? If the problem persists, an administrator might need to look into it.`,
        });
      }
    } catch (dmError) {
      console.error("Failed to send error message to DM:", dmError);
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
  logger
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<ViewSubmitAction>) => {
  await ack();

  try {
    const { user } = body;
    const { values } = body.view.state;
    
    // Extract form values
    const sectionTitle = values.section_title_input?.section_title?.value || '';
    const sectionBody = values.section_body_input?.section_body?.value || '';
    
    // Extract metadata
    const metadata = JSON.parse(body.view.private_metadata || '{}');
    const { recommendedFile, userId, editUrl } = metadata;

    logger.info(`New section modal submitted by user ${user.id}`);
    logger.info(`Section title: ${sectionTitle}`);
    logger.info(`Section body length: ${sectionBody.length}`);
    logger.info(`Recommended file: ${recommendedFile}`);

    if (!sectionTitle || !sectionBody) {
      await client.chat.postMessage({
        channel: user.id,
        text: "❌ Section title and body are required."
      });
      return;
    }

    if (!recommendedFile) {
      await client.chat.postMessage({
        channel: user.id,
        text: "❌ No recommended file found. Please try again."
      });
      return;
    }

    // 벡터 스토어 인스턴스 가져오기
    const vectorStore = VectorStoreService.getInstance();

    // 1. 벡터 스토어에 새 섹션 추가
    const success = await vectorStore.addNewSection(
      recommendedFile,
      sectionTitle,
      sectionBody
    );

    if (!success) {
      await client.chat.postMessage({
        channel: user.id,
        text: `❌ Failed to add new section to vector store for file: ${recommendedFile}`
      });
      return;
    }

    // 2. 업데이트된 마크다운 파일 가져오기
    const markdownFile = vectorStore.getMarkdownFile(recommendedFile);
    if (!markdownFile) {
      await client.chat.postMessage({
        channel: user.id,
        text: `❌ Updated markdown file not found: ${recommendedFile}`
      });
      return;
    }

    // 3. 트리를 마크다운으로 변환
    const { treeToMarkdown } = await import("services/document/markdown");
    const updatedMarkdown = treeToMarkdown(markdownFile.tree);

    // 4. GitHub URL 파싱
    const githubUrl = markdownFile.githubUrl;
    const parsedUrl = parseGithubUrl(githubUrl);
    if (!parsedUrl) {
      await client.chat.postMessage({
        channel: user.id,
        text: `❌ Invalid GitHub URL: ${githubUrl}`
      });
      return;
    }

    const { owner, repo, path: repoPath } = parsedUrl;

    // 5. 커밋 메시지 생성
    const userName = await getUserName(userId, client);
    const commitMessage = `Add new section: ${sectionTitle}

Added by: ${userName}
File: ${recommendedFile}
Content: ${sectionBody.substring(0, 100)}${sectionBody.length > 100 ? '...' : ''}`;

    // 6. GitHub에 파일 업데이트
    const githubService = GithubService.getInstance();
    await githubService.updateMarkdownFile({
      owner,
      repo,
      path: markdownFile.path, // 실제 파일 경로 사용
      content: updatedMarkdown,
      message: commitMessage,
    });

    // 7. 성공 메시지 전송
    await client.chat.postMessage({
      channel: user.id,
      text: `✅ New section "${sectionTitle}" added successfully to GitHub!

📁 *File:* <${githubUrl}|${recommendedFile}>
📝 *Added by:* ${userName}

🔍 *Preview:*
\`\`\`# ${sectionTitle}
${sectionBody.substring(0, 200)}${sectionBody.length > 200 ? '...' : ''}\`\`\``
    });

    logger.info(`Successfully created new section "${sectionTitle}" for ${recommendedFile} and pushed to GitHub`);

  } catch (error) {
    logger.error("Error handling new section modal submission:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to process new section submission: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
};
