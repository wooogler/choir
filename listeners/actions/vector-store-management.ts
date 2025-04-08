import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";

/**
 * 벡터 스토어 캐시 재구축 액션 핸들러
 */
export const rebuildVectorCacheAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // 사용자 ID 추출
    const userId = body.user.id;

    // 작업이 오래 걸릴 수 있다는 메시지 표시
    await client.chat.postMessage({
      channel: userId,
      text: "벡터 스토어 캐시를 재구축하는 중입니다. 잠시만 기다려주세요...",
    });

    // 서비스 로드 및 캐시 재구축
    const VectorStoreService = (await import("../../services/index"))
      .VectorStoreService;
    const vectorStore = VectorStoreService.getInstance();
    const result = await vectorStore.forceRebuildCache();

    // 결과 보고
    if (result) {
      await client.chat.postMessage({
        channel: userId,
        text: "✅ 벡터 스토어 캐시가 성공적으로 재구축되었습니다!",
      });
    } else {
      await client.chat.postMessage({
        channel: userId,
        text: "❌ 벡터 스토어 캐시 재구축 중 문제가 발생했습니다. 로그를 확인해주세요.",
      });
    }
  } catch (error) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ 오류 발생: ${error}`,
    });
  }
};

/**
 * 벡터 스토어 긴급 초기화 액션 핸들러
 */
export const resetVectorStoreAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // 사용자 ID 추출
    const userId = body.user.id;

    // 작업이 오래 걸릴 수 있다는 메시지 표시
    await client.chat.postMessage({
      channel: userId,
      text: "⚠️ 벡터 스토어를 완전히 초기화하고 재구축하는 중입니다. 이 작업은 몇 분 정도 소요될 수 있습니다...",
    });

    // 서비스 로드 및 전체 초기화 실행
    const VectorStoreService = (await import("../../services/index"))
      .VectorStoreService;
    const vectorStore = VectorStoreService.getInstance();
    const result = await vectorStore.resetAndRebuildVectorStore();

    // 결과 보고
    if (result) {
      await client.chat.postMessage({
        channel: userId,
        text: "✅ 벡터 스토어가 성공적으로 초기화되고 재구축되었습니다!",
      });
    } else {
      await client.chat.postMessage({
        channel: userId,
        text: "❌ 벡터 스토어 초기화 및 재구축에 실패했습니다. 로그를 확인해주세요.",
      });
    }
  } catch (error) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `❌ 긴급 초기화 중 오류 발생: ${error}`,
    });
  }
};
