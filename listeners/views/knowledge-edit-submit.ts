import type {
  AllMiddlewareArgs,
  SlackViewMiddlewareArgs,
  SlackViewAction,
} from "@slack/bolt";
import { getSessionData, SessionType, storeSessionData } from "services/common";
import { getChannelName, getManagers, getWorkspaceId, getUserName } from "services/slack";
import suggestUpdatesCallback from "../document-handlers/suggest-updates";

/**
 * Handle knowledge edit modal submission
 */
export async function handleKnowledgeEditModal({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs<SlackViewAction>) {
  await ack();

  try {
    const sessionId = body.view.private_metadata;
    
    if (!sessionId) {
      throw new Error("No session ID found in modal metadata");
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

    // Get edited knowledge from modal input
    const stateValues = body.view.state.values;
    const editedKnowledge = stateValues.knowledge_input?.knowledge_text?.value;

    if (!editedKnowledge || editedKnowledge.trim() === "") {
      await client.chat.postMessage({
        channel: body.user.id,
        text: "❌ Please provide some knowledge content before proceeding.",
      });
      return;
    }

    // Update session data with edited knowledge
    sessionData.extractedKnowledge = editedKnowledge.trim();
    sessionData.lastEditedBy = body.user.id;
    sessionData.lastEditedAt = new Date().toISOString();
    
    // Store updated session data
    storeSessionData(sessionId, sessionData, SessionType.CONSULTATION);

    // Update the original preview message in the channel/thread
    try {
      // Get managers for the message
      const workspaceId = await getWorkspaceId(client);
      const managers = getManagers(workspaceId);
      let managerText = "managers";
      if (managers.length > 0) {
        // Get first manager's name as example
        const firstManagerName = await getUserName(managers[0], client);
        managerText = managers.length === 1 ? firstManagerName : `${firstManagerName} and other managers`;
      }
      
      // Find the original public message to update
      if (sessionData.publicMessageTs) {
        await client.chat.update({
          channel: sessionData.originalChannelId,
          ts: sessionData.publicMessageTs,
          text: `Sure! I'll suggest the following update to ${managerText}. (Edited)`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Sure! I'll suggest the following update to ${managerText}. *(Edited)*`
              }
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Suggested Update*\n\`\`\`${editedKnowledge.trim()}\`\`\``
              }
            }
          ]
        });
      }
    } catch (updateError) {
      logger.warn("Failed to update original public message:", updateError);
      // Continue without sending DM if public message update fails
    }

    logger.info(`Knowledge edited by user ${body.user.id} for session ${sessionId}`);

  } catch (error) {
    logger.error("Error processing knowledge edit modal:", error);
    
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ Error processing knowledge edit: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    });
  }
} 