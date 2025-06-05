import { createSlackMessageWithName, SlackMessage, getChannelName, isBotUser, getWorkspaceId, isManager, getManagers, getUserName } from "services/slack";
import { WebClient } from "@slack/web-api";
import { generateSessionId, storeSessionData, SessionType } from "services/common";
import { extractKnowledgeFromMessages } from "services/llm/knowledge-extractor";

interface MessageResult {
  ts: string;
  channel: string;
  ok: boolean;
}

/**
 * Handle update request message with automatic knowledge extraction
 */
export async function handleUpdateRequestMessage(client: WebClient, event: any, logger: any) {
  try {
    const userId = event.user;
    const originalChannelId = event.channel;
    const isThreadMention = !!event.thread_ts;
    
    // Show loading message in the original channel/thread
    const loadingMessage = await client.chat.postMessage({
        channel: originalChannelId,
        ...(isThreadMention && { thread_ts: event.thread_ts }),
      text: "🔍 Analyzing recent messages (last 5 minutes) to extract knowledge...",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
            text: "🔍 Analyzing recent messages (last 5 minutes) to extract knowledge..."
          }
        }
      ]
    });

    if (!loadingMessage.ts) {
      throw new Error("Failed to post loading message");
    }

    // Get message history (last 10 messages within the last 5 minutes)
    const fiveMinutesAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
    
    const historyResult = isThreadMention ? 
      await client.conversations.replies({
        channel: originalChannelId,
        ts: event.thread_ts,
        limit: 15, // Get more to filter out bot messages
        inclusive: true,
        oldest: fiveMinutesAgo.toString() // Only get messages from the last 5 minutes
      }) :
      await client.conversations.history({
        channel: originalChannelId,
        limit: 15, // Get more to filter out bot messages
        oldest: fiveMinutesAgo.toString() // Only get messages from the last 5 minutes
      });

    if (!historyResult.messages?.length) {
      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        text: "❌ No messages found to analyze.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "❌ No messages found to analyze."
              }
          }
        ]
      });
      return false;
    }
    
    // Sort messages by timestamp (oldest first) and filter out bot messages
      const messages = [...(historyResult.messages ?? [])]
        .sort((a, b) => {
          const tsA = parseFloat(a.ts || '0');
          const tsB = parseFloat(b.ts || '0');
        return tsA - tsB;
        });

    // Filter out bot messages
      const nonBotMessages = await Promise.all(
        messages.map(async (msg: any) => {
          if (!msg.user) return null;
          const isBot = await isBotUser(msg.user, client);
          return isBot ? null : msg;
        })
      );

      const slackMessages = (
        await Promise.all(
          nonBotMessages
            .filter((msg): msg is any => msg !== null)
            .map((msg: any) => createSlackMessageWithName(msg, client))
        )
      ).filter((msg): msg is SlackMessage => msg !== null);

    // Take the last 10 non-bot messages
    const last10Messages = slackMessages.slice(-10);

    if (last10Messages.length === 0) {
      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        text: "❌ No user messages found to analyze.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "❌ No user messages found to analyze."
            }
          }
        ]
      });
      return false;
    }

    try {
      // Extract knowledge from messages
      const extractionResult = await extractKnowledgeFromMessages(last10Messages);
      
      // Generate session ID for this knowledge extraction
      const sessionId = generateSessionId("knowledge_extraction");

      // Get channel name for display
      const channelName = await getChannelName(originalChannelId, client);

      // Get initial extractor's display name
      const extractorInfo = await client.users.info({ user: userId });
      const extractorName = extractorInfo.user?.profile?.display_name || extractorInfo.user?.real_name || extractorInfo.user?.name || "Unknown User";
      const extractTime = new Date().toLocaleString();

      // Check if user is a manager
      const workspaceId = await getWorkspaceId(client);
      const isUserManager = isManager(workspaceId, userId);

      // Get managers for the message
      const managers = getManagers(workspaceId);
      let managerText = "managers";
      if (managers.length > 0) {
        // Get first manager's name as example
        const firstManagerName = await getUserName(managers[0], client);
        managerText = managers.length === 1 ? firstManagerName : `${firstManagerName} and other managers`;
      }

      // Delete the loading message first
      await client.chat.delete({
        channel: originalChannelId,
        ts: loadingMessage.ts
      });

      // First: Send public message with the suggested update content
      const publicMessage = await client.chat.postMessage({
        channel: originalChannelId,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        text: `Sure! I'll suggest the following update to ${managerText}.`,
        blocks: [
          {
            type: "section",
          text: {
              type: "mrkdwn",
              text: `Sure! I'll suggest the following update to ${managerText}.`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
              text: `*Suggested Update*\n\`\`\`${extractionResult.cleanContent}\`\`\``
            }
          }
        ]
      });

      // Wait 1 second to ensure the public message appears first
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Second: Send ephemeral message with buttons for the requester only
      const ephemeralMessage = await client.chat.postEphemeral({
        channel: originalChannelId,
        user: userId,
        text: "You can edit the suggested update if needed.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "You can edit the suggested update if needed."
            }
        },
        {
          type: "actions",
          elements: [
            {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Edit",
                  emoji: true
                },
                action_id: "edit_extracted_knowledge",
                value: sessionId
              }
            ]
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "When you're ready, click Suggest Update to confirm."
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Suggest Update",
                  emoji: true
                },
                style: "primary",
                action_id: isUserManager ? "apply_extracted_knowledge" : "send_update_suggestion_to_manager",
                value: sessionId
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Cancel",
                  emoji: true
                },
                style: "danger",
                action_id: "cancel_knowledge_extraction",
                value: sessionId
              }
            ]
          }
        ]
      });

      // Store session data
      storeSessionData(sessionId, {
                  originalChannelId,
        originalThreadTs: event.thread_ts,
        userId,
        extractedKnowledge: extractionResult.cleanContent, // Store clean content for editing
        detailedKnowledge: extractionResult.detailedContent, // Store detailed content for source viewing
        knowledgeItem: extractionResult.knowledgeItem, // Store structured data
        messages: last10Messages,
        publicMessageTs: publicMessage.ts, // Store public message timestamp for updates
        lastEditedBy: userId, // Track who initially extracted the knowledge
        lastEditedAt: new Date().toISOString() // Track when it was initially extracted
      }, SessionType.DOCUMENT_UPDATE);

      return true;

    } catch (extractionError) {
      logger.error("Error extracting knowledge:", extractionError);
      
      await client.chat.update({
        channel: originalChannelId,
        ts: loadingMessage.ts,
        text: "❌ Failed to extract knowledge from messages.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `❌ Failed to extract knowledge from messages: ${extractionError instanceof Error ? extractionError.message : "Unknown error"}`
            }
          }
        ]
      });
      
      return false;
    }

  } catch (error) {
    logger.error("Error handling update request message:", error);
    throw error;
  }
} 