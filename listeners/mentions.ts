import type { AllMiddlewareArgs, App, SlackEventMiddlewareArgs } from "@slack/bolt";
import { handleIncomingMessage } from "./document-handlers/message-handler";
import suggestUpdatesCallback from "./document-handlers/suggest-updates";
import { handleDocumentSelection } from "./document-handlers/select-update";
import { applySelectedToGithubAction } from "./document-handlers/update-documents";

/**
 * 앱 멘션 처리 콜백
 */
const appMentionCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_mention">) => {
  try {
    // 멘션 이벤트에서 사용자 메시지 추출 (봇 ID 제거)
    const userMessage = "text" in event && typeof event.text === "string" ? event.text.replace(/<@[A-Z0-9]+>/, "").trim() : "";
    if (!userMessage) return;

    // 공유 메시지 핸들러를 사용하여 메시지 처리
    await handleIncomingMessage(client, event, userMessage, logger);
  } catch (error) {
    logger.error("Error processing app mention:", error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: "죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.",
    });
  }
};

const register = (app: App) => {
  app.event("app_mention", appMentionCallback);
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("document_selection", handleDocumentSelection);
  app.action("apply_selected_to_github", applySelectedToGithubAction);
}

export default { register }; 