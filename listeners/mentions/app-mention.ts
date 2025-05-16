import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { classifyMessageIntent } from "../../services/completions";
import { handleQuestionMessage } from "./handlers/question-handler";
import { handleUpdateRequestMessage } from "./handlers/update-handler";

const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">) => {
  try {
    // Get user message from the mention event
    const userMessage = "text" in event ? event.text.replace(/<@[A-Z0-9]+>/, "").trim() : "";
    if (!userMessage) return;

    // Classify message intent (question or update request)
    const messageIntent = await classifyMessageIntent(userMessage);
    logger.info(`Message intent classified as: ${messageIntent}`);

    if (messageIntent === "question") {
      // Handle as a question
      await handleQuestionMessage(client, event, userMessage, logger);
    } else {
      // Handle as update request
      await handleUpdateRequestMessage(client, event, logger);
    }
  } catch (error) {
    logger.error("Error processing app mention:", error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "I'm sorry. An error occurred. Please try again.",
    });
  }
};

export default appMentionCallback;
