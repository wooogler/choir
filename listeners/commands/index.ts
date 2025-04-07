import type { App } from "@slack/bolt";
import sampleCommandCallback from "./sample-command";
import fs from "fs";
import path from "path";

const register = (app: App) => {
  app.command("/sample-command", sampleCommandCallback);

  // Vector store 진단 명령어 추가
  app.command("/vector-diagnosis", async ({ command, ack, respond }) => {
    await ack();

    try {
      const VectorStoreService = (await import("../../services/index"))
        .VectorStoreService;
      const vectorStore = VectorStoreService.getInstance();

      // 자세한 진단 정보 수집
      const diagnosis = vectorStore.diagnoseVectorStore();

      // 캐시 파일 정보 가져오기
      const cacheManager = vectorStore.getCacheManager();
      const cacheFiles = await cacheManager.findCacheFiles();

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

      // 슬랙에 진단 결과 표시
      await respond({
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
      });
    } catch (error) {
      await respond({
        text: `벡터 스토어 진단 중 오류가 발생했습니다: ${error}`,
      });
    }
  });

  // 긴급 복구 명령어 추가
  app.command("/vector-reset", async ({ command, ack, respond, client }) => {
    await ack();

    try {
      // 사용자에게 작업 시작 알림
      await respond({
        response_type: "ephemeral",
        text: "⚠️ 벡터 스토어 긴급 초기화 및 재구축을 시작합니다. 이 작업은 몇 분 정도 소요될 수 있습니다...",
      });

      const VectorStoreService = (await import("../../services/index"))
        .VectorStoreService;
      const vectorStore = VectorStoreService.getInstance();

      // 초기화 및 재구축 실행
      const result = await vectorStore.resetAndRebuildVectorStore();

      if (result) {
        await respond({
          response_type: "ephemeral",
          text: "✅ 벡터 스토어가 성공적으로 초기화되고 재구축되었습니다!",
        });
      } else {
        await respond({
          response_type: "ephemeral",
          text: "❌ 벡터 스토어 초기화 및 재구축에 실패했습니다. 로그를 확인해주세요.",
        });
      }
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: `긴급 초기화 중 오류가 발생했습니다: ${error}`,
      });
    }
  });
};

export default { register };
