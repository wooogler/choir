import { App, LogLevel } from '@slack/bolt';
import * as dotenv from 'dotenv';
import registerListeners from './listeners';

import { GithubService } from './services/github';

import { AppConfig } from '@/config';
import { Logger } from 'services/common/logger';
import { getAIProvider, validateCurrentProvider } from 'services/llm';
import { getGithubRepo, getWorkspaceId, setupInitialManager } from 'services/slack';
import { HomeScreenService } from 'services/slack/home-screen';
import { withRateLimit } from 'services/slack/rate-limit-handler';
import { VectorStoreService } from 'services/vector/main-service';

dotenv.config();

/** Initialization */
const slackConfig = AppConfig.getSlackConfig();
const app = new App({
  token: slackConfig.botToken,
  socketMode: slackConfig.socketMode,
  signingSecret: slackConfig.signingSecret,
  logLevel: LogLevel.INFO,
  appToken: slackConfig.appToken,
  clientOptions: {
    retryConfig: {
      retries: 3,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 30000,
      randomize: true,
    },
  },
});

const githubService = GithubService.getInstance();
const vectorStore = VectorStoreService.getInstance();

/** Register Listeners */
registerListeners(app);

// Note: app_home_opened event is registered in registerListeners()

/** Start Bolt App */
(async () => {
  try {
    // AI Provider 설정 검증
    const aiProvider = getAIProvider();
    app.logger.info(`AI Provider: ${aiProvider}`);

    if (!validateCurrentProvider()) {
      app.logger.error(`${aiProvider} configuration is invalid. Please check your environment variables.`);
      if (aiProvider === 'azure') {
        app.logger.error(
          'Required variables: AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT_NAME, AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME',
        );
      } else {
        app.logger.error('Required variables: OPENAI_API_KEY');
      }
      process.exit(1);
    }
    app.logger.info(`${aiProvider} configuration is valid`);

    // 워크스페이스 ID 가져오기 (첫 번째 호출에서 캐시됨)
    const workspaceId = await getWorkspaceId(app.client);

    // API 호출 사이에 짧은 지연 (rate limit 방지)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 워크스페이스 소유자를 초기 관리자로 설정 (rate limit 처리)
    let workspaceOwner: string | undefined;
    try {
      // 워크스페이스 관리자 찾기 - 사용자 목록에서 is_owner가 true인 사용자
      const usersList = await withRateLimit(() => app.client.users.list({}), 'get users list for workspace owner');
      const owner = usersList.members?.find((user) => user.is_owner === true);

      if (owner?.id) {
        workspaceOwner = owner.id;

        // 또 다른 짧은 지연
        await new Promise((resolve) => setTimeout(resolve, 500));

        await setupInitialManager(workspaceId, owner.id, app.client);
        app.logger.info(`Initialized workspace owner (${owner.id}) as a manager`);
      } else {
        app.logger.warn('Could not find workspace owner in user list');
      }
    } catch (error) {
      app.logger.warn('Failed to setup initial manager:', error);
    }

    // 저장된 GitHub 저장소 정보 가져오기
    const repoInfo = await getGithubRepo(workspaceId);

    if (repoInfo) {
      app.logger.info(`Using saved GitHub repository: ${repoInfo.owner}/${repoInfo.repo}`);

      // 먼저 캐시에서 벡터 스토어 초기화 시도
      const cacheInitialized = await vectorStore.initializeFromCacheOnly(repoInfo.owner, repoInfo.repo);

      if (cacheInitialized) {
        app.logger.info('Vector store successfully initialized from cache. Skipping GitHub API calls.');
      } else {
        app.logger.info('Cache not available or invalid. Fetching from GitHub...');

        try {
          // 캐시가 없거나 무효한 경우에만 GitHub API 호출
          const markdownFiles = await githubService.getAllMarkdownFiles({
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            path: repoInfo.path,
            workspaceId: workspaceId,
            userId: workspaceOwner, // 워크스페이스 소유자 ID 사용
          });

          await vectorStore.setMarkdownFiles(markdownFiles, {
            owner: repoInfo.owner,
            repo: repoInfo.repo,
          });
        } catch (error) {
          app.logger.info('Connected GitHub repository not accessible. Starting with empty vector store.');
          // Initialize empty vector store
          await vectorStore.setMarkdownFiles([], {
            owner: 'empty',
            repo: 'empty',
          });
        }
      }
    } else {
      app.logger.info('No GitHub repository configured. Starting with empty vector store.');
      // Initialize empty vector store
      await vectorStore.setMarkdownFiles([], {
        owner: 'empty',
        repo: 'empty',
      });
    }

    await app.start(process.env.PORT || 3000);
    app.logger.info('⚡️ Bolt app is running! ⚡️');
  } catch (error) {
    app.logger.error('Unable to start App', error);
  }
})();
