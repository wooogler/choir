import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, BlockButtonAction } from "@slack/bolt";
import { getSessionData, SessionType } from "../../../../services/common";
import { WebClient } from "@slack/web-api";
import { Logger } from "@slack/bolt";
import { getUserName } from "../../../../services/slack";
import { logButtonClick } from "../../../../services/common/user-interaction-logger";

/**
 * Handle "Cancel" button click during suggestion related flows
 */
export const cancelUpdateSuggestionReviewCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  const startTime = Date.now();
  await ack();

  try {
    const sessionId = body.actions[0].value;
    const userId = body.user.id;
    const userName = await getUserName(userId, client);
    
    if (!sessionId) {
      logger.warn("No session ID provided for cancellation");
      if (body.channel?.id) {
        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: userId,
            text: "Sorry, I couldn't process the cancellation because the session ID was missing. Please try again or contact support if this continues."
        });
      }
      
      // 로그: 세션 ID 없음
      logButtonClick(
        userId,
        'unknown',
        body.channel?.id || 'dm',
        'dm',
        'cancel_update_suggestion_review',
        Date.now() - startTime,
        false,
        {
          error: "No session ID provided"
        }
      );
      return;
    }
    
    const sessionData = getSessionData(sessionId, SessionType.DOCUMENT_UPDATE) as any;
    const shortSessionId = sessionId.substring(sessionId.length - 6);

    if (sessionData?.originalChannelId) {
      let cancelledByText = sessionData.userId === userId ? "*You* (the suggester)" : `*${userName}*`;
      if (sessionData.userId && sessionData.userId !== userId) {
        const suggesterName = sessionData.userName || await getUserName(sessionData.userId, client) || "the original suggester";
        cancelledByText = `*${userName}* (reviewer). The original suggestion was from *${suggesterName}*.`;
      }

      await client.chat.postMessage({
        channel: sessionData.originalChannelId,
        ...(sessionData.originalThreadTs ? { thread_ts: sessionData.originalThreadTs } : {}),
        text: `Update suggestion review (ID: ${shortSessionId}) has been cancelled.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🙅‍♀️ Okay, the document update suggestion (ID: ${shortSessionId}) has been cancelled by ${cancelledByText}. No further action will be taken on this one for now. If you change your mind, you can always start a new suggestion!`
            }
          }
        ]
      });
    }

    if (sessionData?.managerMessageInfo) {
      for (const managerId in sessionData.managerMessageInfo) {
        if (sessionData.managerMessageInfo.hasOwnProperty(managerId)) {
          const messageDetail = sessionData.managerMessageInfo[managerId];
          if (messageDetail.ts && messageDetail.channel) {
            try {
              let managerCancellationText = `🙅‍♀️ The document update suggestion (ID: ${shortSessionId}) was cancelled by *${userName}*.`;
              if (sessionData.userId && sessionData.userId !== userId) {
                 managerCancellationText = `🙅‍♀️ The document update suggestion (ID: ${shortSessionId}), originally from *${sessionData.userName || "User"}*, was cancelled by another reviewer (*${userName}*).`;
              } else if (sessionData.userId && sessionData.userId === userId) {
                 managerCancellationText = `🙅‍♀️ The document update suggestion (ID: ${shortSessionId}) from *${sessionData.userName || "User"}* was cancelled by them.`;
              }

              await client.chat.update({
                channel: messageDetail.channel,
                ts: messageDetail.ts,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: managerCancellationText + " No further action is needed from your side for this one. Thanks!"
                    }
                  }
                ],
                text: "Suggestion review cancelled."
              });
            } catch (updateError) {
              logger.error(`Failed to update manager message for cancellation, session ${sessionId}, manager ${managerId}:`, updateError);
            }
          }
        }
      }
    }

    if (body.container?.message_ts && body.channel?.id) {
        try {
            let userCancellationText = `Got it! I've cancelled this update suggestion (ID: ${shortSessionId}). Feel free to start a new one anytime!`;
            if(sessionData?.managerMessageInfo && sessionData.managerMessageInfo[userId] && sessionData.managerMessageInfo[userId].ts === body.container.message_ts){
                userCancellationText = `Okay, I've marked the suggestion (ID: ${shortSessionId}) from *${sessionData.userName || "the user"}* as cancelled. No further action from you is needed on this.`;
            } else if (sessionData?.userId === userId) {
                userCancellationText = `Okay, *${userName}*, I've cancelled your update suggestion (ID: ${shortSessionId}). No problem at all! If you want to suggest something else, just let me know.`;
            } else {
                 userCancellationText = `The update suggestion (ID: ${shortSessionId}) has been cancelled by *${userName}*.`;
            }

            await client.chat.update({
                channel: body.channel.id,
                ts: body.container.message_ts,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: userCancellationText
                    }
                  }
                ],
                text: "Update suggestion cancelled."
            });
        } catch (e) {
            logger.error("Failed to update user's own message for cancellation: ", e);
        }
    }

    logger.info(`Update suggestion review cancelled by user ${userId} (${userName}) for session ${sessionId}`);

    // 로그: 성공
    logButtonClick(
      userId,
      'unknown',
      body.channel?.id || 'dm',
      'dm',
      'cancel_update_suggestion_review',
      Date.now() - startTime,
      true,
      {
        sessionId,
        shortSessionId,
        originalUserId: sessionData?.userId,
        originalChannelId: sessionData?.originalChannelId,
        originalThreadTs: sessionData?.originalThreadTs,
        isOriginalSuggester: sessionData?.userId === userId,
        managersNotified: sessionData?.managerMessageInfo ? Object.keys(sessionData.managerMessageInfo).length : 0,
        originalMessageUpdated: !!(body.container?.message_ts && body.channel?.id)
      }
    );

  } catch (error) {
    logger.error("Error cancelling suggestion review:", error);
    
    if (body.channel?.id) {
        await client.chat.postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `😥 Oops! I couldn't cancel the suggestion review right now. Error: ${error instanceof Error ? error.message : "Unknown error"}. Please try again!`
        });
    }

    // 로그: 실패
    logButtonClick(
      body.user.id,
      'unknown',
      body.channel?.id || 'dm',
      'dm',
      'cancel_update_suggestion_review',
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