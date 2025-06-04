import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType, storeSessionData } from "../../../../services/common";
import { getManagers, getWorkspaceId, getChannelName, getUserName } from "../../../../services/slack";
import { createMessageLink } from "../suggestions/suggest-updates";
import { WebClient } from "@slack/web-api";
import { Logger } from "@slack/bolt";

/**
 * Handle "Pass Suggestion to Manager" button click
 */
export const sendUpdateSuggestionToManagerCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const sessionId = body.actions[0].value;
    
    if (!sessionId) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Invalid session. Please try submitting your suggestion again.",
      });
      return;
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Session data not found. Please try submitting your suggestion again.",
      });
      return;
    }

    const workspaceId = await getWorkspaceId(client);
    const managers = getManagers(workspaceId);

    if (managers.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ No managers found in this workspace. Please contact an administrator.",
      });
      return;
    }

    const userInfo = await client.users.info({ user: body.user.id });
    // Ensure userName is fetched correctly, fallback to a generic term if needed.
    const userName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || "A team member";

    sessionData.userId = body.user.id;
    sessionData.userName = userName; // 세션 데이터에도 사용자 이름 저장 (취소 등 다른 액션에서 사용 가능)

    if (!sessionData.managerMessageInfo) {
      sessionData.managerMessageInfo = {};
    }

    // CHOIR의 메시지 템플릿
    const choirGreeting = `Hi there! I'm CHOIR, your friendly documentation assistant. 👋\n\n*${userName}* has a suggestion for updating our documents, and I'm helping to pass it along for review.`;
    const choirCallToAction = `Could you please take a look and decide on the next steps? You can edit the suggested content or start the update process directly from here.`;

    for (const managerId of managers) {
      try {
        let originalMessageLinkBlock = null;
        let messageLink = "";
        try {
          const conversationInfo = await client.conversations.info({ channel: sessionData.originalChannelId });
          if (conversationInfo.ok && conversationInfo.channel && 
              (!conversationInfo.channel.is_private || conversationInfo.channel.is_member)) {
            const authInfo = await client.auth.test();
            const workspaceUrl = authInfo.url;
            if (workspaceUrl) {
              messageLink = createMessageLink(workspaceUrl, sessionData.originalChannelId, sessionData.originalThreadTs);
              originalMessageLinkBlock = {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `📍 <${messageLink}|View original discussion> for context`
                }
              };
            }
          }
        } catch (linkError) {
          logger.warn(`Could not create original message link for channel ${sessionData.originalChannelId}:`, linkError);
        }

        if (messageLink) {
          sessionData.originalMessageLink = messageLink;
        }

        const blocks: any[] = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: choirGreeting
            }
          },
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "📝 Document Update Suggestion",
              emoji: true
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*From:* *${userName}*`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Suggestion:*\n\`\`\`${sessionData.extractedKnowledge}\`\`\``
            }
          }
        ];

        if (originalMessageLinkBlock) {
          blocks.push(originalMessageLinkBlock);
        }
        
        blocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: choirCallToAction
            }
          },
          {
          type: "actions",
          elements: [
            {
              type: "button" as "button",
              text: {
                type: "plain_text" as "plain_text",
                text: "✏️ Edit Suggestion",
                emoji: true
              },
              action_id: "open_knowledge_edit_manager_modal",
              value: sessionId 
            },
            {
              type: "button" as "button",
              text: {
                type: "plain_text" as "plain_text",
                text: "🚀 Start Update Process",
                emoji: true
              },
              style: "primary" as "primary",
              action_id: "suggest_updates", 
              value: JSON.stringify({
                sessionId: sessionId,
                knowledgeContent: sessionData.extractedKnowledge,
                originalChannelId: sessionData.originalChannelId, 
                originalThreadTs: sessionData.originalThreadTs,
              })
            },
            {
              type: "button" as "button",
              text: {
                type: "plain_text" as "plain_text",
                text: "Dismiss", 
                emoji: false
              },
              style: "danger" as "danger",
              action_id: "cancel_knowledge_extraction",
              value: sessionId
            }
          ]
        });

        const postedMessage = await client.chat.postMessage({
          channel: managerId,
          text: `📝 New document update suggestion from *${userName}* for your review.`,
          blocks: blocks,
          unfurl_links: false,
          unfurl_media: false,
        });

        if (postedMessage.ok && postedMessage.ts && postedMessage.channel) {
          sessionData.managerMessageInfo[managerId] = {
            ts: postedMessage.ts,
            channel: postedMessage.channel,
          };
        }
      } catch (error) {
        logger.error(`Failed to send suggestion to manager ${managerId}:`, error);
      }
    }

    storeSessionData(sessionId, sessionData, SessionType.DOCUMENT_UPDATE);

    // 원래 채널에 알림 메시지 전송
    if (sessionData.originalChannelId) {
      const originalChannelName = await getChannelName(sessionData.originalChannelId, client);
      
      // 매니저 이름 목록을 볼드체로 변환
      const managerNames = await Promise.all(managers.map(id => getUserName(id, client)));
      const managerNamesBold = managerNames.map(name => `*${name}*`).join(", ");

      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        text: `✅ Great news, *${userName}*! Your document update suggestion has been successfully sent to our manager(s): ${managerNamesBold}. They'll review it soon! (Sent from channel: #${originalChannelName})`,
        thread_ts: sessionData.originalThreadTs,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ Great news, *${userName}*! Your document update suggestion has been successfully sent to our manager(s): ${managerNamesBold}. They'll review it soon!

I'll let you know if they have any questions or when the document is updated. Thanks for helping keep our docs accurate! 👍`
            }
          }
        ],
        unfurl_links: false,
        unfurl_media: false,
      });
    } else {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Your update suggestion has been passed to ${managers.length} manager(s) for review. They will be able to apply the suggestion to update documents or provide feedback.`
      });
    }

    logger.info(`Update suggestion passed to managers by *${userName}* (ID: ${body.user.id}) for session ${sessionId}`);

  } catch (error) {
    logger.error("Error passing update suggestion to managers:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to pass your update suggestion to managers: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}; 