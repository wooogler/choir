import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType } from "services/common";
import { getManagers, getWorkspaceId, getUserName, createPrivateMessagePreview } from "services/slack";

/**
 * 멤버 선택 모달 열기
 */
export const askToOthersModalCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const sessionId = body.actions[0].value;
    if (!sessionId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || "",
        user: body.user.id,
        text: "😅 Oops! Something went wrong. Could you try asking your question again?",
      });
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const managers = getManagers(workspaceId);

    // 세션 데이터 가져오기 (preview용)
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || "",
        user: body.user.id,
        text: "😅 I can't find the conversation details. Mind asking your question again?",
      });
      return;
    }

    // 질문자 이름 가져오기
    const questionerName = await getUserName(body.user.id, client);

    // Preview 생성 (static preview with both options shown)
    const previewText = createPrivateMessagePreview(
      "Selected person(s)",
      `(*${questionerName}* OR *a team member*)`,
      sessionData.originalQuestion,
      sessionData.botResponse
    );

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "ask_to_others_submit",
        private_metadata: sessionId,
        title: {
          type: "plain_text",
          text: "🔒 Ask in Private",
          emoji: true
        },
        submit: {
          type: "plain_text",
          text: "Send Privately",
          emoji: true
        },
        close: {
          type: "plain_text",
          text: "Cancel",
          emoji: true
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🔒 *Who would you like to ask privately?*\n_They'll receive this Q&A as a direct message for private discussion._"
            }
          },
          {
            type: "input",
            block_id: "users_select",
            element: {
              type: "multi_users_select",
              action_id: "users",
              placeholder: {
                type: "plain_text",
                text: "Choose people to share with..."
              },
              ...(managers.length > 0 && { initial_users: managers })
            },
            label: {
              type: "plain_text",
              text: "👤 People",
              emoji: true
            }
          },
          {
            type: "input",
            block_id: "anonymous_select",
            element: {
              type: "checkboxes",
              action_id: "anonymous_checkbox_private",
              options: [
                {
                  text: {
                    type: "plain_text",
                    text: "Share anonymously (show as 'A team member' instead of your name)"
                  },
                  value: "anonymous"
                }
              ]
            },
            label: {
              type: "plain_text",
              text: "🎭 Privacy Options",
              emoji: true
            },
            optional: true
          },
          {
            type: "divider"
          },
          {
            type: "section",
            block_id: "preview_section",
            text: {
              type: "mrkdwn",
              text: "👀 *Here's what will be shared:*"
            }
          },
          {
            type: "section",
            block_id: "preview_content",
            text: {
              type: "mrkdwn",
              text: previewText
            }
          }
        ]
      }
    });

    logger.info(`Others selection modal opened for session ${sessionId}`);
  } catch (error) {
    logger.error("Error opening others selection modal:", error);
    
    await client.chat.postEphemeral({
      channel: body.channel?.id || "",
      user: body.user.id,
      text: "😔 Something went wrong opening the sharing options. Could you try again?",
    });
  }
};

