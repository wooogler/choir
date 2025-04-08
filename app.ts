import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";
import registerListeners from "./listeners";
import { VectorStoreService } from "./services/index";
import {
  getWorkspaceId,
  setupInitialManager,
  getGithubRepo,
} from "./services/slack-utils";
import GithubService from "./services/github";

dotenv.config();

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.DEBUG,
});

const githubService = GithubService.getInstance();
const vectorStore = VectorStoreService.getInstance();

/** Register Listeners */
registerListeners(app);

/** Start Bolt App */
(async () => {
  try {
    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(app.client);

    // 워크스페이스 소유자를 초기 관리자로 설정
    try {
      // 워크스페이스 관리자 찾기 - 사용자 목록에서 is_owner가 true인 사용자
      const usersList = await app.client.users.list({});
      const owner = usersList.members?.find((user) => user.is_owner === true);

      if (owner?.id) {
        setupInitialManager(workspaceId, owner.id);
        app.logger.info(
          `Initialized workspace owner (${owner.id}) as a manager`
        );
      } else {
        app.logger.warn("Could not find workspace owner in user list");
      }
    } catch (error) {
      app.logger.warn("Failed to setup initial manager:", error);
    }

    // 저장된 GitHub 저장소 정보 가져오기
    const repoInfo = getGithubRepo(workspaceId);

    if (repoInfo) {
      app.logger.info(
        `Using saved GitHub repository: ${repoInfo.owner}/${repoInfo.repo}`
      );

      // 저장된 저장소 정보로 마크다운 파일 가져오기
      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        path: repoInfo.path,
      });

      await vectorStore.setMarkdownFiles(markdownFiles, {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
      });
    } else {
      app.logger.info(
        "No GitHub repository configured. Using default repository."
      );

      // 기본 저장소 설정 (예시 또는 개발용)
      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner: "wooogler",
        repo: "choir_docs",
        path: "",
      });

      await vectorStore.setMarkdownFiles(markdownFiles, {
        owner: "wooogler",
        repo: "choir_docs",
      });
    }

    await app.start(process.env.PORT || 3000);
    app.logger.info("⚡️ Bolt app is running! ⚡️");
  } catch (error) {
    app.logger.error("Unable to start App", error);
  }
})();
