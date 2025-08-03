import type { AllMiddlewareArgs, BlockButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { SessionType, getSessionData } from 'services/common';
import { logButtonClick } from 'services/common/user-interaction-logger';
import { createPrivateMessagePreview, getManagers, getUserName, getWorkspaceId } from 'services/slack';

/**
 * 멤버 선택 모달 열기
 */
export const askToOthersModalCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  // response_url로 기존 ephemeral 메시지를 업데이트
  try {
    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replace_original: true,
          text: '✅ Setting up private discussion...',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '✅ *Setting up private discussion...*\nOpening participant selection modal.',
              },
            },
          ],
        }),
      });
    }
  } catch (error) {
    logger.warn('Failed to update ephemeral message via response_url:', error);
  }



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
    const managers = await getManagers(workspaceId);

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



    // 질문자 이름 가져오기
    const questionerName = await getUserName(body.user.id, client);

    // Preview 생성 (static preview with both options shown)
    const previewText = createPrivateMessagePreview(
      'Selected person(s)',
      `(*${questionerName}* OR *a team member*)`,
      sessionData.originalQuestion,
      sessionData.botResponse,
      true, // canAnswer - assume true for preview
      false, // not anonymous for preview
    );

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'ask_to_others_submit',
        notify_on_close: true,
        private_metadata: sessionId,
        title: {
          type: 'plain_text',
          text: '🔒 Ask in Private',
          emoji: true,
        },
        submit: {
          type: 'plain_text',
          text: 'Send Privately',
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
              text: "🔒 *Who would you like to ask privately?*\n_They'll receive this Q&A as a direct message for private discussion. You can also add your own thoughts or context._",
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
            block_id: 'users_select',
            element: {
              type: 'multi_users_select',
              action_id: 'users',
              placeholder: {
                type: 'plain_text',
                text: 'Choose people to share with...',
              },
              ...(managers.length > 0 && { initial_users: managers }),
            },
            label: {
              type: 'plain_text',
              text: '👤 People',
              emoji: true,
            },
          },
          {
            type: 'input',
            block_id: 'anonymous_select',
            element: {
              type: 'checkboxes',
              action_id: 'anonymous_checkbox_private',
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: "Share anonymously (show as 'A team member' and exclude me from the DM)",
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

    logger.info(`Others selection modal opened for session ${sessionId}`);

    // 로그: 성공
    // 채널 타입 결정
    let channelType: 'public' | 'private' | 'dm' = 'public';
    try {
      if (body.channel?.id) {
        const channelInfo = await client.conversations.info({ channel: body.channel.id });
        if (channelInfo.channel?.is_private) {
          channelType = 'private';
        } else if (channelInfo.channel?.is_im) {
          channelType = 'dm';
        }
      }
    } catch (channelInfoError) {
      logger.warn('Could not get channel info for logging:', channelInfoError);
    }

    await logButtonClick(
      body.user.id,
      workspaceId,
      body.channel?.id || '',
      channelType,
      'ask_to_others_modal',
      Date.now() - startTime,
      true,
      {
        sessionId,
        managersCount: managers.length,
      },
      client,
    );
  } catch (error) {
    logger.error('Error opening others selection modal:', error);

    await client.chat.postEphemeral({
      channel: body.channel?.id || '',
      user: body.user.id,
      text: '😔 Something went wrong opening the sharing options. Could you try again?',
    });

    // 로그: 실패
    try {
      const workspaceId = await getWorkspaceId(client);
      // 채널 타입 결정
      let channelType: 'public' | 'private' | 'dm' = 'public';
      try {
        if (body.channel?.id) {
          const channelInfo = await client.conversations.info({ channel: body.channel.id });
          if (channelInfo.channel?.is_private) {
            channelType = 'private';
          } else if (channelInfo.channel?.is_im) {
            channelType = 'dm';
          }
        }
      } catch (channelInfoError) {
        logger.warn('Could not get channel info for error logging:', channelInfoError);
      }

      await logButtonClick(
        body.user.id,
        workspaceId,
        body.channel?.id || '',
        channelType,
        'ask_to_others_modal',
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
