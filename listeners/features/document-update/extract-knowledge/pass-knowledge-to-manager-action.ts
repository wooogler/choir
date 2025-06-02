import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType, storeSessionData } from "../../../../services/common";
import { getManagers, getWorkspaceId, getChannelName } from "../../../../services/slack";
import { createMessageLink } from "../suggestions/suggest-updates";
import { WebClient } from "@slack/web-api";
import { Logger } from "@slack/bolt";

/**
 * Handle "Pass Knowledge to Manager" button click
 */
export const passKnowledgeToManagerCallback = async ({
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
        text: "❌ Invalid session. Please try the knowledge extraction again.",
      });
      return;
    }

    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Session data not found. Please try the knowledge extraction again.",
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
    const userName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || "Unknown User";

    sessionData.userId = body.user.id;
    sessionData.userName = userName;

    if (!sessionData.managerMessageInfo) {
      sessionData.managerMessageInfo = {};
    }

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
              text: `*From:* <@${body.user.id}> (${userName})`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Content:*\n\`\`\`${sessionData.extractedKnowledge}\`\`\``
            }
          }
        ];

        if (originalMessageLinkBlock) {
          blocks.push(originalMessageLinkBlock);
        }
        
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button" as "button",
              text: {
                type: "plain_text" as "plain_text",
                text: "Edit Knowledge",
                emoji: true
              },
              action_id: "open_knowledge_edit_manager_modal",
              value: sessionId 
            },
            {
              type: "button" as "button",
              text: {
                type: "plain_text" as "plain_text",
                text: "Start Document Update",
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
                emoji: true
              },
              style: "danger" as "danger",
              action_id: "cancel_knowledge_extraction", 
              value: sessionId
            }
          ]
        });

        const postedMessage = await client.chat.postMessage({
          channel: managerId,
          text: `📝 Knowledge passed from ${userName} for document update review.`,
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
        logger.error(`Failed to send knowledge to manager ${managerId}:`, error);
      }
    }

    storeSessionData(sessionId, sessionData, SessionType.CONSULTATION);

    await client.chat.postMessage({
      channel: body.user.id,
      text: `✅ Knowledge has been passed to ${managers.length} manager(s) for review.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ Knowledge has been passed to ${managers.length} manager(s) for review.\\n\\nThey will be able to apply the knowledge to update documents or provide feedback.`
          }
        }
      ]
    });

    logger.info(`Knowledge passed to managers by user ${body.user.id} for session ${sessionId}`);

  } catch (error) {
    logger.error("Error passing knowledge to managers:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to pass knowledge to managers: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}; 