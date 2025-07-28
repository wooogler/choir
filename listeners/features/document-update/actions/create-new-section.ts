import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import type { ModalView } from '@slack/web-api';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { GithubService } from 'services/github';
import { getWorkspaceId } from 'services/slack';
import { WorkspaceStore } from 'services/workspace/workspace-store';

export const createNewSectionAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // Variables that need to be accessible in catch block
  let workspaceId: string | undefined;
  let originalChannelId: string | undefined;

  try {
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const { newSectionSessionId, userId } = parsedValue;

    // Store the original message info for later update
    const originalMessageTs = body.container?.message_ts;
    const buttonChannelId = body.channel?.id;

    // Get workspace info early for logging
    workspaceId = await getWorkspaceId(client);

    // 세션에서 새 섹션 데이터 가져오기
    const newSectionData = getSessionData(newSectionSessionId, SessionType.NEW_SECTION);
    if (!newSectionData) {
      throw new Error('New section data not found in session');
    }

    const {
      sectionTitle,
      sectionContent,
      recommendedFile,
      reasoning,
      githubUrl,
      originalChannelId: originalChannelIdFromSession,
      originalThreadTs,
      sessionId,
    } = newSectionData;

    // Assign to outer scope variable for error logging
    originalChannelId = originalChannelIdFromSession;

    // Get available markdown files for file selection dropdown
    const workspaceStore = new WorkspaceStore();
    const config = await workspaceStore.getWorkspaceConfig(workspaceId);
    if (!config || !config.githubRepo) {
      throw new Error('Workspace configuration or GitHub repository not found');
    }

    // Get writable files for file selection dropdown (excludes read-only files)
    let fileList = await workspaceStore.getWritableFiles(workspaceId);

    if (!fileList || fileList.length === 0) {
      // If no cached writable files, load from GitHub and cache, then filter
      const { owner, repo, path } = config.githubRepo;
      const githubService = GithubService.getInstance();
      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner,
        repo,
        path,
        workspaceId: workspaceId,
        userId: userId,
      });

      // Cache all files
      await workspaceStore.setMarkdownFilesCache(workspaceId, markdownFiles.map((file) => ({
        name: file.name,
        path: file.path,
      })));

      // Get writable files after caching
      fileList = await workspaceStore.getWritableFiles(workspaceId);
    }

    // If no writable files available, show error
    if (!fileList || fileList.length === 0) {
      await client.chat.postEphemeral({
        channel: userId, // Use DM channel
        user: userId,
        text: '❌ No writable files available for new sections. All files are marked as read-only.',
      });
      return;
    }

    // Create file options for dropdown (only writable files)
    const fileOptions = fileList.map((file) => ({
      text: {
        type: 'plain_text' as const,
        text: file.name,
      },
      value: file.path,
    }));

    // Find the recommended file option
    const recommendedFileOption = fileOptions.find((option) => option.value === recommendedFile);

    // GitHub 편집 URL 생성 함수
    const { owner, repo, path, branch } = config.githubRepo;
    const createEditUrl = (filePath: string) => {
      const branchName = branch || 'main';
      return `https://github.com/${owner}/${repo}/edit/${branchName}/${filePath}`;
    };

    // 추천 파일의 편집 URL
    const recommendedFileEditUrl = createEditUrl(recommendedFile);

    // 복사할 텍스트 생성 - 첫 번째 항목을 리스트 아이템으로 변환
    const contentLines = sectionContent.split('\n');
    const firstLine = contentLines[0];
    const restOfContent = contentLines.slice(1).join('\n');

    // 첫 번째 줄이 이미 리스트 형태가 아니라면 리스트 아이템으로 변환
    const formattedFirstLine =
      firstLine.trim().startsWith('-') || firstLine.trim().startsWith('*') || /^\d+\./.test(firstLine.trim())
        ? firstLine
        : `- ${firstLine}`;

    const copyText = `# ${sectionTitle}\n${formattedFirstLine}${restOfContent ? '\n' + restOfContent : ''}`;

    // 제목과 본문 분리
    const sectionTitleForEdit = sectionTitle;
    const sectionBodyForEdit = `${formattedFirstLine}${restOfContent ? '\n' + restOfContent : ''}`;

    const modal: ModalView = {
      type: 'modal' as const,
      callback_id: 'new_section_modal',
      notify_on_close: true,
      title: {
        type: 'plain_text' as const,
        text: 'Create a New Section',
      },
      close: {
        type: 'plain_text' as const,
        text: 'Cancel',
      },
      submit: {
        type: 'plain_text' as const,
        text: 'Submit',
        emoji: true,
      },
      private_metadata: JSON.stringify({
        newSectionSessionId,
        recommendedFileEditUrl,
        recommendedFile,
        owner,
        repo,
        copyText,
        sectionTitle,
        originalChannelId: originalChannelId,
        originalThreadTs,
        userId,
        sessionId,
        buttonMessageTs: originalMessageTs,
        buttonChannelId: buttonChannelId,
      }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `👋 I've prepared a new section for your documentation. Review and edit the content below, then click *Submit* to automatically add it to your selected file.`,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'input',
          block_id: 'file_selection_input',
          label: {
            type: 'plain_text',
            text: 'Select Target File',
            emoji: true,
          },
          element: {
            type: 'static_select',
            action_id: 'file_selection',
            placeholder: {
              type: 'plain_text',
              text: 'Choose a file...',
            },
            initial_option: recommendedFileOption || fileOptions[0],
            options: fileOptions,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "*🎯 Here's the section I've prepared for you:*",
          },
        },
        {
          type: 'input',
          block_id: 'section_title_input',
          label: {
            type: 'plain_text',
            text: 'Section Title',
            emoji: true,
          },
          element: {
            type: 'plain_text_input',
            action_id: 'section_title',
            initial_value: sectionTitleForEdit,
            placeholder: {
              type: 'plain_text',
              text: 'Enter section title...',
            },
          },
        },
        {
          type: 'input',
          block_id: 'section_body_input',
          label: {
            type: 'plain_text',
            text: 'Section Content',
            emoji: true,
          },
          element: {
            type: 'plain_text_input',
            action_id: 'section_body',
            initial_value: sectionBodyForEdit,
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: 'Enter section content...',
            },
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📝 *Alternatively, you can edit the file manually:* <${recommendedFileEditUrl}|Open ${recommendedFile.split('/').pop()} in GitHub>`,
          },
        },
      ],
    };

    if (!body.trigger_id) {
      throw new Error('Trigger ID not found');
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: modal,
    });

    // 로그: 성공
    await logButtonClick(
      body.user.id,
      workspaceId,
      originalChannelId || body.channel?.id || 'dm',
      originalChannelId ? 'public' : 'dm',
      'create_new_section',
      Date.now() - startTime,
      true,
      {
        newSectionSessionId,
        sessionId,
        sectionTitle,
        sectionContent,
        sectionContentLength: sectionContent.length,
        recommendedFile,
        reasoningLength: reasoning.length,
        githubUrl,
        originalChannelId,
        originalThreadTs,
        editUrl: recommendedFileEditUrl,
      },
      client,
    );
  } catch (error) {
    logger.error('Error creating new section modal:', error);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to open new section modal: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });

    // 로그: 실패
    try {
      const logWorkspaceId = workspaceId || (await getWorkspaceId(client));
      await logButtonClick(
        body.user.id,
        logWorkspaceId,
        originalChannelId || body.channel?.id || 'dm',
        originalChannelId ? 'public' : 'dm',
        'create_new_section',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          errorStack: error instanceof Error ? error.stack : undefined,
          buttonValue: body.actions?.[0]?.value,
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging button click failure:', logError);
    }
  }
};
