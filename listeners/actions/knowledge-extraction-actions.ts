import type { App, AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { generateSessionId, SessionType, storeSessionData, getSessionData } from "services/common";
import { handleKnowledgeEditModal } from "../views/knowledge-edit-submit";
import suggestUpdatesCallback from "../document-handlers/suggest-updates";
import { getManagers, getWorkspaceId, getChannelName } from "services/slack";
import { createMessageLink } from "../document-handlers/suggest-updates";

/**
 * Handle "Edit Knowledge" button click
 */
const editExtractedKnowledgeCallback = async ({
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

    // Get session data
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Session data not found. Please try the knowledge extraction again.",
      });
      return;
    }

    // Open modal for editing knowledge
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "knowledge_edit_modal",
        private_metadata: sessionId,
        title: {
          type: "plain_text",
          text: "Edit Knowledge",
          emoji: true
        },
        submit: {
          type: "plain_text",
          text: "Update Knowledge",
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
              text: "*Edit the extracted knowledge before applying updates:*"
            }
          },
          {
            type: "input",
            block_id: "knowledge_input",
            element: {
              type: "plain_text_input",
              action_id: "knowledge_text",
              multiline: true,
              initial_value: sessionData.extractedKnowledge || "",
              placeholder: {
                type: "plain_text",
                text: "Enter the knowledge to be documented..."
              }
            },
            label: {
              type: "plain_text",
              text: "Knowledge Content",
              emoji: true
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `📊 *Source:* ${sessionData.messages?.length || 0} messages analyzed`
              }
            ]
          }
        ]
      }
    });

    logger.info(`Knowledge edit modal opened for session ${sessionId}`);

  } catch (error) {
    logger.error("Error opening knowledge edit modal:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: "❌ Failed to open edit modal. Please try again.",
    });
  }
};

/**
 * Handle "Apply Updates" button click
 */
const applyExtractedKnowledgeCallback = async ({
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

    // Get session data
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Session data not found. Please try the knowledge extraction again.",
      });
      return;
    }

    // Get team_id and bot_id for the slack:// URL
    const authInfo = await client.auth.test();
    
    const teamId = authInfo.team_id;
    const botUserId = authInfo.user_id;

    if (!teamId || !botUserId) {
      logger.error("Failed to get team_id or user_id for DM link");
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Could not create a link to DM. Please try again or contact support."
      });
      return;
    }

    // Send public notification to channel
    await client.chat.postMessage({
      channel: sessionData.originalChannelId,
      ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
      text: "🔄 Processing knowledge and generating document updates...",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔄 Manager is processing the knowledge and generating document updates..."
          }
        }
      ]
    });

    // Show ephemeral processing message with DM button
    await client.chat.postEphemeral({
      channel: sessionData.originalChannelId,
      user: body.user.id,
      text: "🔄 Processing knowledge and generating document updates...",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔄 Processing knowledge and generating document updates...\nDocument suggestions will be sent to your DM."
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Open DM",
                emoji: true
              },
              style: "primary",
              url: `slack://user?team=${teamId}&id=${botUserId}&tab=messages`
            }
          ]
        }
      ]
    });

    // Prepare source messages based on knowledgeItem.source indices
    let sourceMessages = [];
    if (sessionData.knowledgeItem?.source && sessionData.messages) {
      sourceMessages = sessionData.knowledgeItem.source.map((messageIndex: number) => {
        return sessionData.messages[messageIndex - 1]; // Convert to 0-based index
      }).filter(Boolean); // Remove any undefined entries
    }

    // Update session data with source messages for easier access
    sessionData.sourceMessages = sourceMessages;
    storeSessionData(sessionId, sessionData, SessionType.CONSULTATION);

    // Call existing suggest updates callback with the knowledge as a "message"
    await suggestUpdatesCallback({
      ack: async () => {},
      body: {
        user: { id: sessionData.userId },
        channel: { id: body.user.id }, // Send to user's DM
        actions: [
          {
            value: JSON.stringify({
              originalChannelId: sessionData.originalChannelId,
              originalThreadTs: sessionData.originalThreadTs,
              action: "generate_updates",
              knowledgeContent: sessionData.extractedKnowledge,
              sessionId: sessionId // sessionId만 전달
            })
          }
        ],
        container: { thread_ts: sessionData.originalThreadTs }
      },
      client,
      logger
    } as any);

    logger.info(`Knowledge applied for session ${sessionId}`);

  } catch (error) {
    logger.error("Error applying extracted knowledge:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to apply knowledge: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
};

/**
 * Handle "Cancel" button click
 */
const cancelKnowledgeExtractionCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const sessionId = body.actions[0].value;
    
    if (!sessionId) {
      logger.warn("No session ID provided for cancellation");
      return;
    }
    
    // Get session data for channel info
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    
    // Send public notification to channel if session data exists
    if (sessionData?.originalChannelId) {
      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
        text: "❌ Knowledge extraction cancelled.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "❌ The team member cancelled the knowledge extraction."
            }
          }
        ]
      });
    }

    logger.info(`Knowledge extraction cancelled by user ${body.user.id}`);

  } catch (error) {
    logger.error("Error cancelling knowledge extraction:", error);
    
    // If cancellation fails, send an ephemeral error message
    await client.chat.postEphemeral({
      channel: body.channel?.id || "",
      user: body.user.id,
      text: `❌ Failed to cancel: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
};

/**
 * Handle "Pass Knowledge to Manager" button click
 */
const passKnowledgeToManagerCallback = async ({
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

    // Get session data
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Session data not found. Please try the knowledge extraction again.",
      });
      return;
    }

    // Get workspace ID and managers
    const workspaceId = await getWorkspaceId(client);
    const managers = getManagers(workspaceId);

    if (managers.length === 0) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ No managers found in this workspace. Please contact an administrator.",
      });
      return;
    }

    // Get user info for display
    const userInfo = await client.users.info({ user: body.user.id });
    const userName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || "Unknown User";

    // Store original requester info in sessionData
    sessionData.userId = body.user.id; // This is the ID of the user who clicked "Pass Knowledge to Manager"
    sessionData.userName = userName;

    // Get channel name for context
    const channelName = await getChannelName(sessionData.originalChannelId, client);
    const isThreadMention = !!sessionData.originalThreadTs;

    // Initialize managerMessageInfo if it doesn't exist
    if (!sessionData.managerMessageInfo) {
      sessionData.managerMessageInfo = {};
    }

    // Send knowledge to each manager
    for (const managerId of managers) {
      try {
        // 원본 메시지 링크 생성 (접근 가능할 때만)
        let originalMessageLinkBlock = null;
        let messageLink = ""; // Initialize messageLink
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

        // Store the created messageLink in sessionData if it was successfully created
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
              text: `*Knowledge:*\n\`\`\`${sessionData.extractedKnowledge}\`\`\``
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
              type: "button",
              text: {
                type: "plain_text",
                text: "Edit Knowledge",
                emoji: true
              },
              action_id: "open_knowledge_edit_manager_modal",
              value: sessionId 
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Start Document Update",
                emoji: true
              },
              style: "primary",
              action_id: "suggest_updates", 
              value: JSON.stringify({
                sessionId: sessionId,
                knowledgeContent: sessionData.extractedKnowledge,
                originalChannelId: sessionData.originalChannelId, 
                originalThreadTs: sessionData.originalThreadTs,
              })
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Dismiss",
                emoji: true
              },
              style: "danger",
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

        // Store original message ts and channel for each manager
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

    // Store updated session data
    storeSessionData(sessionId, sessionData, SessionType.CONSULTATION);

    // Send confirmation to the original user
    await client.chat.postMessage({
      channel: body.user.id,
      text: `✅ Knowledge has been passed to ${managers.length} manager(s) for review.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ Knowledge has been passed to ${managers.length} manager(s) for review.\n\nThey will be able to apply the knowledge to update documents or provide feedback.`
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

const openKnowledgeEditManagerModalCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();
  try {
    const sessionId = body.actions[0].value;
    if (!sessionId) {
      throw new Error("No session ID provided for manager knowledge edit modal");
    }

    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    if (!sessionData) {
      throw new Error("Session data not found for manager knowledge edit modal");
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "knowledge_edit_manager_modal", // 이 ID로 view submission 핸들러가 호출됨
        private_metadata: sessionId,
        title: {
          type: "plain_text",
          text: "Edit Submitted Knowledge",
          emoji: true,
        },
        submit: {
          type: "plain_text",
          text: "Update Knowledge",
          emoji: true,
        },
        close: {
          type: "plain_text",
          text: "Cancel",
          emoji: true,
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Edit the knowledge submitted by the user:*",
            },
          },
          {
            type: "input",
            block_id: "knowledge_input",
            element: {
              type: "plain_text_input",
              action_id: "knowledge_text",
              multiline: true,
              initial_value: sessionData.extractedKnowledge || "",
            },
            label: {
              type: "plain_text",
              text: "Knowledge Content",
              emoji: true,
            },
          },
        ],
      },
    });
    logger.info(`Manager knowledge edit modal opened for session ${sessionId} by manager ${body.user.id}`);
  } catch (error) {
    logger.error("Error opening manager knowledge edit modal:", error);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Failed to open knowledge edit modal: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
};

const register = (app: App) => {
  app.action("edit_extracted_knowledge", editExtractedKnowledgeCallback);
  app.action("apply_extracted_knowledge", applyExtractedKnowledgeCallback);
  app.action("cancel_knowledge_extraction", cancelKnowledgeExtractionCallback);
  app.action("pass_knowledge_to_manager", passKnowledgeToManagerCallback);
  app.action("open_knowledge_edit_manager_modal", openKnowledgeEditManagerModalCallback);
  
  // Register modal view handler
  app.view("knowledge_edit_modal", handleKnowledgeEditModal);
};

export default { register };

export { editExtractedKnowledgeCallback, applyExtractedKnowledgeCallback, cancelKnowledgeExtractionCallback, passKnowledgeToManagerCallback, openKnowledgeEditManagerModalCallback };