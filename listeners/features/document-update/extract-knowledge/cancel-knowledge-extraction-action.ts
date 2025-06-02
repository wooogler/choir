import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType } from "../../../../services/common";
import { WebClient } from "@slack/web-api";
import { Logger } from "@slack/bolt";

/**
 * Handle "Cancel" button click during knowledge extraction related flows
 */
export const cancelKnowledgeExtractionCallback = async ({
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
      // Optionally, send an ephemeral message to the user if possible, though channel info might be missing
      if (body.channel?.id) {
        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: body.user.id,
            text: "Could not process cancellation: session ID missing."
        });
      }
      return;
    }
    
    const sessionData = getSessionData(sessionId, SessionType.CONSULTATION) as any;
    
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

    // Also, update the message in the manager's DM if it exists
    if (sessionData?.managerMessageInfo) {
      for (const managerId in sessionData.managerMessageInfo) {
        if (sessionData.managerMessageInfo.hasOwnProperty(managerId)) {
          const messageDetail = sessionData.managerMessageInfo[managerId];
          if (messageDetail.ts && messageDetail.channel) {
            try {
              await client.chat.update({
                channel: messageDetail.channel,
                ts: messageDetail.ts,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `🙅‍♀️ Knowledge submission (ID: ${sessionId.substring(sessionId.length - 6)}) was cancelled by the user.`
                    }
                  }
                ],
                text: "Knowledge submission cancelled by user."
              });
            } catch (updateError) {
              logger.error(`Failed to update manager message for cancellation, session ${sessionId}, manager ${managerId}:`, updateError);
            }
          }
        }
      }
    }

    // And update the user's own suggestion message if they clicked cancel there
    if (body.container?.message_ts && body.channel?.id && sessionData?.userId && body.channel.id === sessionData.userId) { // Check if it's user's own DM and sessionData.userId exists
        try {
            await client.chat.update({
                channel: body.channel.id,
                ts: body.container.message_ts,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `❌ You have cancelled this knowledge extraction suggestion (ID: ${sessionId.substring(sessionId.length - 6)}).` 
                    }
                  }
                ],
                text: "Knowledge extraction cancelled."
            });
        } catch (e) {
            logger.error("Failed to update user's own message for cancellation: ", e);
        }
    }


    logger.info(`Knowledge extraction cancelled by user ${body.user.id} for session ${sessionId}`);

  } catch (error) {
    logger.error("Error cancelling knowledge extraction:", error);
    
    if (body.channel?.id) {
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `❌ Failed to process cancellation: ${error instanceof Error ? error.message : "Unknown error"}`
        });
    }
  }
}; 