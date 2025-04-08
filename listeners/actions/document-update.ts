import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { VectorStoreService } from "../../services/index";
import { handleDocumentSelection } from "./document-selection";
import {
  getStoredDocumentUpdates,
  getStoredThreadTs,
  getSelectedNodeIds,
  clearSelectedNodeIds,
} from "../../services/document-store";
import { applySelectedToGithub } from "../../services/github";
import { SlackMessage } from "services/slack-utils";

// GitHub에 변경사항 적용
export const applySelectedToGithubAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const channelId = body.channel?.id;
    const value = body.actions[0].value;
    const parsedValue = JSON.parse(value || "{}");

    // validMessages 예외 처리
    let validMessages: SlackMessage[] = [];
    try {
      if (
        parsedValue.validMessages &&
        Array.isArray(parsedValue.validMessages)
      ) {
        validMessages = parsedValue.validMessages;
      } else {
        console.warn(
          "유효한 메시지 배열이 없거나 잘못된 형식입니다:",
          parsedValue.validMessages
        );
      }
    } catch (error) {
      console.error("validMessages 파싱 중 오류 발생:", error);
    }

    if (!channelId) {
      throw new Error("채널 ID를 찾을 수 없습니다");
    }

    // 사용자가 선택한 노드 ID 가져오기
    const selectedNodeIdsArray = getSelectedNodeIds(userId);

    // 선택된 문서가 없는 경우
    if (selectedNodeIdsArray.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "선택된 문서가 없습니다. 업데이트할 문서를 선택해주세요.",
      });
      return;
    }

    // 저장된 documentUpdates 가져오기
    const documentUpdates = getStoredDocumentUpdates(userId);
    const thread_ts = getStoredThreadTs(userId);

    // 업데이트 진행 중 메시지 전송 (댓글 쓰레드에 표시)
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: thread_ts,
      text: "선택한 문서를 GitHub에 업데이트 중입니다...",
    });

    // VectorStoreService 인스턴스 생성
    const vectorStore = VectorStoreService.getInstance();

    // GitHub에 변경사항 적용
    const results = await applySelectedToGithub({
      userId,
      channelId,
      client,
      selectedNodeIds: selectedNodeIdsArray,
      documentUpdates,
      vectorStore,
      validMessages,
    });

    // 벡터 스토어 재구축
    await vectorStore.forceRebuildCache();

    // 사용자에게 결과 전송
    const resultMessage =
      results.length > 0
        ? results.map((r) => r.message).join("\n")
        : "선택된 문서가 없습니다.";

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: thread_ts,
      text: `*문서 업데이트 결과*\n\n${resultMessage}`,
    });

    // 업데이트 완료 후 선택 노드 초기화
    clearSelectedNodeIds(userId);
  } catch (error) {
    console.error("선택한 문서 업데이트 중 오류 발생:", error);

    if (body.channel?.id) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: `문서 업데이트 중 오류가 발생했습니다: ${
          error instanceof Error ? error.message : "알 수 없는 오류"
        }`,
      });
    }
  }
};
