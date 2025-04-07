import type { App } from "@slack/bolt";
import sampleActionCallback from "./sample-action";
import suggestUpdatesCallback, {
  handleDocumentSelection,
  applySelectedToGithub,
} from "./suggest-updates";
import startDiscussionCallback from "./start-discussion";
import applyUpdateCallback from "./apply-update";
import {
  selectUserCallback,
  addManagerCallback,
  removeManagerCallback,
} from "./manage-permissions";
import {
  githubRepoUrlInputCallback,
  testGithubConnectionCallback,
} from "./github-connection";

const register = (app: App) => {
  app.action("sample_action_id", sampleActionCallback);
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("start_discussion", startDiscussionCallback);
  app.action("start_discussion_selected", startDiscussionCallback);
  app.action("apply_update", applyUpdateCallback);

  // 관리자 권한 관리 액션 등록
  app.action("select_user_for_permission", selectUserCallback);
  app.action("add_manager_permission", addManagerCallback);
  app.action("remove_manager_permission", removeManagerCallback);

  // GitHub 저장소 연동 액션 등록
  app.action("github_repo_url_input", githubRepoUrlInputCallback);
  app.action("test_github_connection", testGithubConnectionCallback);

  // 벡터 스토어 진단 액션 등록
  app.action("diagnose_vector_store", async ({ ack, body, client }) => {
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
      const cacheFiles = cacheManager
        ? await cacheManager.findCacheFiles()
        : [];

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
  });

  // 벡터 스토어 관리 액션 등록
  app.action("rebuild_vector_cache", async ({ ack, body, client }) => {
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
  });

  // 벡터 스토어 긴급 초기화 액션 등록
  app.action("reset_vector_store", async ({ ack, body, client }) => {
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
  });

  // 문서 업데이트 관련 액션 등록
  app.action("document_selection", handleDocumentSelection);
  app.action("apply_selected_to_github", applySelectedToGithub);
};

export default { register };
