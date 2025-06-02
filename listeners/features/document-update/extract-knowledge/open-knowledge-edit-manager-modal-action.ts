import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType } from "../../../../services/common";
import { WebClient } from "@slack/web-api";
import { Logger } from "@slack/bolt";

/**
 * Handle "Edit Knowledge" button click from a manager's perspective
 */
export const openKnowledgeEditManagerModalCallback = async ({
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
        callback_id: "knowledge_edit_manager_modal", // This ID is handled by handleKnowledgeEditManagerModal
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
      channel: body.user.id, // Send error to the manager who clicked
      text: `❌ Failed to open knowledge edit modal: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}; 