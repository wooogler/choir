import { classifyMessageIntent } from "../../services/completions";
import { handleQuestionMessage } from "./question-handler";
import { handleUpdateRequestMessage } from "./update-request-handler";

/**
 * 메시지 처리를 위한 공통 함수
 * 공통으로 사용할 수 있도록 mentions와 dms에서 모두 호출 가능
 */
export async function handleIncomingMessage(client: any, event: any, message: string, logger: any) {
  try {
    // 메시지 의도 분류 (질문 또는 업데이트 요청)
    const messageIntent = await classifyMessageIntent(message);
    logger.info(`Message intent classified as: ${messageIntent}`);

    if (messageIntent === "question") {
      // 질문으로 처리
      return await handleQuestionMessage(client, event, message, logger);
    } else {
      // 업데이트 요청으로 처리
      return await handleUpdateRequestMessage(client, event, logger);
    }
  } catch (error) {
    logger.error("Error processing message:", error);
    await client.chat.postMessage({
      channel: event.channel,
      ...(event.channel_type !== "im" ? { thread_ts: event.ts } : {}), // DM이 아닌 경우에만 스레드로 응답
      text: "죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.",
    });
    return false;
  }
}