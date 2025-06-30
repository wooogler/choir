import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import type { ModalView } from '@slack/web-api';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';

export const createNewSectionAction = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error('Button value not found');
    }

    const parsedValue = JSON.parse(value);
    const { newSectionSessionId, userId } = parsedValue;

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
      originalChannelId,
      originalThreadTs,
      sessionId,
    } = newSectionData;

    // GitHub edit 링크 생성 (blob을 edit으로 변경)
    const editUrl = githubUrl.replace('/blob/', '/edit/');

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
      title: {
        type: 'plain_text' as const,
        text: '💡 New Section Idea',
      },
      close: {
        type: 'plain_text' as const,
        text: 'Maybe Later',
      },
      submit: {
        type: 'plain_text' as const,
        text: 'Submit',
        emoji: true,
      },
      private_metadata: JSON.stringify({
        newSectionSessionId,
        editUrl,
        recommendedFile,
        copyText,
        sectionTitle,
        originalChannelId,
        originalThreadTs,
        userId,
      }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `👋 Great news! I've crafted a perfect new section for your knowledge.`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📁 *I recommend adding this to:* ${recommendedFile}\n💭 *Here's why:* ${reasoning}`,
          },
        },
        {
          type: 'divider',
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
            text: "✨ *Ready to add this to your documentation?* Edit the content above if needed, then click the button below - I'll take you directly to the right place in GitHub where you can paste it!",
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: "🚀 Let's do this!",
                emoji: true,
              },
              style: 'primary',
              url: editUrl,
            },
          ],
        },
      ],
    };

    await client.views.open({
      trigger_id: body.trigger_id!,
      view: modal,
    });

    // 로그: 성공
    logButtonClick(
      body.user.id,
      'unknown',
      body.channel?.id || 'dm',
      'dm',
      'create_new_section',
      Date.now() - startTime,
      true,
      {
        newSectionSessionId,
        sessionId,
        sectionTitle,
        sectionContentLength: sectionContent.length,
        recommendedFile,
        reasoningLength: reasoning.length,
        githubUrl,
        originalChannelId,
        originalThreadTs,
        editUrl,
      },
    );
  } catch (error) {
    logger.error('Error creating new section modal:', error);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to open new section modal: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });

    // 로그: 실패
    logButtonClick(
      body.user.id,
      'unknown',
      body.channel?.id || 'dm',
      'dm',
      'create_new_section',
      Date.now() - startTime,
      false,
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
        buttonValue: body.actions?.[0]?.value,
      },
    );
  }
};
