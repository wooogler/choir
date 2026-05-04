import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/interaction-tracker';
import { createQAChannelPreview, getQAChannel, getUserName, getWorkspaceId } from 'services/slack';

/**
 * 채널 선택 모달 열기
 */
export const askToChannelModalCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const sessionId = body.actions[0].value;
    if (!sessionId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: '😅 Oops! Something went wrong. Could you try asking your question again?',
      });
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const qaChannelId = await getQAChannel(workspaceId, client);

    // Q&A 채널이 설정되지 않은 경우 에러 처리
    if (!qaChannelId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: '❌ No Q&A channel is configured. Please ask an admin to set up a Q&A channel.',
      });
      return;
    }

    // 세션 데이터 가져오기 (preview용)
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: "😅 I can't find the conversation details. Mind asking your question again?",
      });
      return;
    }

    // Q&A 채널 이름 가져오기
    let channelName = 'qna';
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      channelName = channelInfo.channel?.name || 'qna';
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
    }

    // 질문자 이름 가져오기
    const questionerName = await getUserName(body.user.id, client);

    // Preview 생성 (static preview with both options shown)
    const previewText = createQAChannelPreview(
      channelName,
      body.user.id,
      sessionData.originalQuestion,
      sessionData.botResponse,
      true, // canAnswer - assume true for preview
      false, // not anonymous for preview
      `(*${questionerName}* OR *a team member*)`,
    );

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'ask_to_channel_submit',
        notify_on_close: true,
        private_metadata: JSON.stringify({ sessionId, qaChannelId }), // Q&A 채널 ID 포함
        title: {
          type: 'plain_text',
          text: '📢 Share with Q&A',
          emoji: true,
        },
        submit: {
          type: 'plain_text',
          text: 'Post to Channel',
          emoji: true,
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true,
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📢 *Ready to share this Q&A with #${channelName}?*\n_This will post the question and my response to help others in the channel. You can also add your own thoughts or context._`,
            },
          },
          {
            type: 'input',
            block_id: 'user_comment',
            element: {
              type: 'plain_text_input',
              action_id: 'comment_text',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Add your thoughts or context about this question and answer (optional)',
              },
            },
            label: {
              type: 'plain_text',
              text: '💭 Your Comment',
              emoji: true,
            },
            optional: true,
          },
          {
            type: 'input',
            block_id: 'anonymous_select',
            element: {
              type: 'checkboxes',
              action_id: 'anonymous_checkbox_channel',
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: "Share anonymously (show as 'A team member' instead of your name)",
                  },
                  value: 'anonymous',
                },
              ],
            },
            label: {
              type: 'plain_text',
              text: '🎭 Privacy Options',
              emoji: true,
            },
            optional: true,
          },
          {
            type: 'divider',
          },
          {
            type: 'section',
            block_id: 'preview_section',
            text: {
              type: 'mrkdwn',
              text: "👀 *Here's what will be shared:*",
            },
          },
          {
            type: 'section',
            block_id: 'preview_content',
            text: {
              type: 'mrkdwn',
              text: previewText,
            },
          },
        ],
      },
    });

    logger.info(`Channel selection modal opened for session ${sessionId}`);

    // 로그: 성공
    try {
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'public',
        'ask_to_channel_modal',
        Date.now() - startTime,
        true,
        {
          sessionId,
          qaChannelId,
          qaChannelName: channelName,
        },
        client,
      );
    } catch (logError) {
      logger.error('Error logging button click:', logError);
    }
  } catch (error) {
    logger.error('Error opening channel selection modal:', error);

    await client.chat.postEphemeral({
      channel: body.channel?.id || '',
      user: body.user.id,
      text: '😔 Something went wrong opening the sharing options. Could you try again?',
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        'public',
        'ask_to_channel_modal',
        Date.now() - startTime,
        false,
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          sessionId: body.actions[0].value,
        },
        client,
      );
    } catch (logError) {
      logger.warn('Failed to log error:', logError);
    }
  }
};
