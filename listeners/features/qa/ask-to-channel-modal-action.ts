import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType } from "services/common";
import { getQAChannel, getWorkspaceId, createQAChannelPreview } from "services/slack";

/**
 * 채널 선택 모달 열기
 */
export const askToChannelModalCallback = async ({
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
    const qaChannelId = await getQAChannel(workspaceId, client);

    // Q&A 채널이 설정되지 않은 경우 에러 처리
    if (!qaChannelId) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || "",
        user: body.user.id,
        text: "❌ No Q&A channel is configured. Please ask an admin to set up a Q&A channel.",
      });
      return;
    }

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

    // Q&A 채널 이름 가져오기
    let channelName = "qna";
    try {
      const channelInfo = await client.conversations.info({ channel: qaChannelId });
      channelName = channelInfo.channel?.name || "qna";
    } catch (error) {
      logger.warn(`Could not get Q&A channel name for ${qaChannelId}:`, error);
    }

    // Preview 생성 (공통 함수 사용)
    const previewText = createQAChannelPreview(
      channelName,
      body.user.id,
      sessionData.originalQuestion,
      sessionData.botResponse
    );

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "ask_to_channel_submit",
        private_metadata: JSON.stringify({ sessionId, qaChannelId }), // Q&A 채널 ID 포함
        title: {
          type: "plain_text",
          text: "📢 Share with Q&A",
          emoji: true
        },
        submit: {
          type: "plain_text",
          text: "Post to Channel",
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
              text: `📢 *Ready to share this Q&A with #${channelName}?*\n_This will post the question and my response to help others in the channel._`
            }
          },
          {
            type: "divider"
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "👀 *Here's what will be shared:*"
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: previewText
            }
          }
        ]
      }
    });

    logger.info(`Channel selection modal opened for session ${sessionId}`);
  } catch (error) {
    logger.error("Error opening channel selection modal:", error);
    
    await client.chat.postEphemeral({
      channel: body.channel?.id || "",
      user: body.user.id,
      text: "😔 Something went wrong opening the sharing options. Could you try again?",
    });
  }
};