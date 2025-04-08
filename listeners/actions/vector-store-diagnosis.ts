import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";

/**
 * 벡터 스토어 진단 액션 핸들러
 */
export const diagnoseVectorStoreAction = async ({
  ack,
  body,
  client,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    // 사용자 ID 추출
    const userId = body.user.id;

    // 진단 시작 메시지
    await client.chat.postMessage({
      channel: userId,
      text: "벡터 스토어 진단을 수행 중입니다...",
    });

    // 벡터 스토어 서비스 로드
    const VectorStoreService = (await import("../../services/index"))
      .VectorStoreService;
    const vectorStore = VectorStoreService.getInstance();

    // 진단 실행
    const diagnosis = vectorStore.diagnoseVectorStore();

    // 캐시 파일 정보 가져오기
    const fs = (await import("fs")).default;
    const path = (await import("path")).default;

    // 캐시 파일 찾기
    const cacheManager = vectorStore.getCacheManager
      ? vectorStore.getCacheManager()
      : null;
    const cacheFiles = cacheManager ? await cacheManager.findCacheFiles() : [];

    const filesInfo = cacheFiles
      .map((file: string) => {
        try {
          const stats = fs.statSync(file);
          const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
          const lastModified = stats.mtime.toISOString();
          return `- ${path.basename(
            file
          )}: ${fileSizeInMB}MB (최종 수정: ${lastModified})`;
        } catch (e) {
          return `- ${path.basename(file)}: 파일 정보 읽기 실패`;
        }
      })
      .join("\n");

    // 진단 결과 표시
    await client.chat.postMessage({
      channel: userId,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "벡터 스토어 진단 결과",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*상태:* ${diagnosis.status}\n*정상 여부:* ${
              diagnosis.status === "healthy" ? "✅ 정상" : "❌ 문제 있음"
            }`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*문서 수:* ${diagnosis.details.documentCount}\n*벡터 수:* ${diagnosis.details.vectorsCount}\n*캐시 파일 수:* ${cacheFiles.length}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*캐시 파일 정보:*\n${filesInfo || "캐시 파일 없음"}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "캐시 재구축",
                emoji: true,
              },
              style: "primary",
              action_id: "rebuild_vector_cache",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "긴급 초기화",
                emoji: true,
              },
              style: "danger",
              action_id: "reset_vector_store",
              confirm: {
                title: {
                  type: "plain_text",
                  text: "정말 초기화하시겠습니까?",
                },
                text: {
                  type: "plain_text",
                  text: "벡터 스토어를 완전히 초기화하고 새로 구축합니다. 이 작업은 되돌릴 수 없습니다.",
                },
                confirm: {
                  type: "plain_text",
                  text: "초기화 실행",
                },
                deny: {
                  type: "plain_text",
                  text: "취소",
                },
              },
            },
          ],
        },
      ],
      text: "벡터 스토어 진단 결과입니다.",
    });
  } catch (error) {
    // 오류 발생 시 사용자에게 DM으로 알림
    await client.chat.postMessage({
      channel: body.user.id,
      text: `벡터 스토어 진단 중 오류가 발생했습니다: ${error}`,
    });
  }
};
