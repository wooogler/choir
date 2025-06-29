import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType } from "../../../../services/common";
import { WebClient } from "@slack/web-api";
import { Logger } from "@slack/bolt";
import { logButtonClick } from "../../../../services/common/user-interaction-logger";

/**
 * Handle "Edit Knowledge" button click from a manager's perspective
 */
export const openKnowledgeEditManagerModalCallback = async ({
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
      throw new Error("No session ID provided for manager knowledge edit modal");
    }

    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
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

    // 로그: 성공
    logButtonClick(
      body.user.id,
      'unknown',
      body.channel?.id || 'dm',
      'dm',
      'open_knowledge_edit_manager_modal',
      Date.now() - startTime,
      true,
      {
        sessionId,
        originalUserId: sessionData.userId,
        originalChannelId: sessionData.originalChannelId,
        originalThreadTs: sessionData.originalThreadTs,
        extractedKnowledgeLength: sessionData.extractedKnowledge?.length || 0,
        messagesAnalyzed: sessionData.messages?.length || 0
      }
    );

  } catch (error) {
    logger.error("Error opening manager knowledge edit modal:", error);
    await client.chat.postMessage({
      channel: body.user.id, // Send error to the manager who clicked
      text: `❌ Failed to open knowledge edit modal: ${error instanceof Error ? error.message : "Unknown error"}`,
    });

    // 로그: 실패
    logButtonClick(
      body.user.id,
      'unknown',
      body.channel?.id || 'dm',
      'dm',
      'open_knowledge_edit_manager_modal',
      Date.now() - startTime,
      false,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        errorStack: error instanceof Error ? error.stack : undefined,
        sessionId: body.actions[0].value
      }
    );
  }
}; 