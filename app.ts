import { App, LogLevel } from "@slack/bolt";
import * as dotenv from "dotenv";
import registerListeners from "./listeners";

import GithubService from "./services/github";

import { VectorStoreService } from "services/vector/main-service";
import { getGithubRepo, getWorkspaceId, setupInitialManager } from "services/slack";
import { validateAzureOpenAIConfig, isAzureOpenAIEnabled } from "services/llm";

dotenv.config();

/** Initialization */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: process.env.NODE_ENV !== "production",
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  logLevel: LogLevel.INFO,
  appToken: process.env.SLACK_APP_TOKEN,
});

const githubService = GithubService.getInstance();
const vectorStore = VectorStoreService.getInstance();

/** Register Listeners */
registerListeners(app);

// Register app home event
app.event('app_home_opened', async ({ event, client, logger }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: 'CHOIR - Your AI Assistant',
              emoji: true
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Welcome to CHOIR!*\n\nCHOIR is your AI-powered assistant that helps you find information and answer questions.'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*How to use CHOIR:*\n\n• Send me a DM to ask questions\n• Mention me in any channel with @CHOIR\n• I\'ll help you find relevant information and answer your questions'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Features:*\n\n• Answer questions based on documentation\n• Provide relevant document references\n• Start discussions with team members\n• Help with technical queries'
            }
          }
        ]
      }
    });
  } catch (error) {
    logger.error('Error publishing home tab:', error);
  }
});

/** Start Bolt App */
(async () => {
  try {
    // Azure OpenAI 설정 검증
    if (isAzureOpenAIEnabled()) {
      app.logger.info("Azure OpenAI is enabled, validating configuration...");
      if (!validateAzureOpenAIConfig()) {
        app.logger.error("Azure OpenAI configuration is invalid. Please check your environment variables.");
        app.logger.error("Required variables: AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT_NAME, AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME");
        process.exit(1);
      }
      app.logger.info("Azure OpenAI configuration is valid");
    } else {
      app.logger.info("Azure OpenAI is not enabled. Using default OpenAI configuration.");
    }

    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(app.client);

    // 개발자를 초기 관리자로 설정
    const developerUserId = process.env.DEVELOPER_USER_ID;
    if (developerUserId) {
      await setupInitialManager(workspaceId, developerUserId, app.client);
      app.logger.info(`Initialized developer (${developerUserId}) as a manager`);
    } else {
      app.logger.warn("DEVELOPER_USER_ID environment variable is not set");
    }

    // 워크스페이스 소유자를 초기 관리자로 설정
    try {
      // 워크스페이스 관리자 찾기 - 사용자 목록에서 is_owner가 true인 사용자
      const usersList = await app.client.users.list({});
      const owner = usersList.members?.find((user) => user.is_owner === true);

      if (owner?.id) {
        await setupInitialManager(workspaceId, owner.id, app.client);
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
    const repoInfo = await getGithubRepo(workspaceId);

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

      // 기본 저장소 설정 (환경에 따라 다르게 설정)
      const defaultRepo = process.env.NODE_ENV === 'development' 
        ? { owner: 'wooogler', repo: 'assets', branch: 'master' }
        : { owner: 'wooogler', repo: 'choirlab', branch: 'main' };

      const markdownFiles = await githubService.getAllMarkdownFiles({
        owner: defaultRepo.owner,
        repo: defaultRepo.repo,
        path: "",
        ref: defaultRepo.branch,
      });

      await vectorStore.setMarkdownFiles(markdownFiles, {
        owner: defaultRepo.owner,
        repo: defaultRepo.repo,
      });
    }

    await app.start(process.env.PORT || 3000);
    app.logger.info("⚡️ Bolt app is running! ⚡️");
  } catch (error) {
    app.logger.error("Unable to start App", error);
  }
})();
