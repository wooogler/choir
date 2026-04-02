import type { AllMiddlewareArgs, BlockAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { GithubService } from 'services/github';
import { getWorkspaceId, isManager, isWorkspaceOwner, parseGithubUrl, storeGithubRepo } from 'services/slack';
import { GitHubSyncService } from 'services/sync/github-sync-service';
import { VectorStoreService } from 'services/vector/main-service';
import { WorkspaceStore } from 'services/workspace/workspace-store';
import { appHomeOpenedCallback } from '../../event-handlers/app-home-handler';

// 타입 정의
interface ActionWithValue {
  value: string;
}

interface RepoUrlState {
  userId: string;
  url: string;
}

// 임시로 입력된 URL을 저장
const urlInputStore = new Map<string, RepoUrlState>();

/**
 * GitHub 저장소 URL 입력 처리
 */
export const githubRepoUrlInputCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // 관리자 권한 확인
    const isUserManager = isManager(workspaceId, userId);
    const isOwner = await isWorkspaceOwner(userId, client);

    if (!isUserManager && !isOwner) {
      logger.warn(`User ${userId} attempted to input GitHub URL without permission`);
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: 'Only administrators can connect GitHub repositories.',
      });
      return;
    }

    // 입력된 URL 가져오기
    const action = body.actions[0] as unknown as ActionWithValue;
    const url = action.value;

    if (!url) {
      logger.warn('Empty GitHub URL input');
      return;
    }

    // 입력된 URL 임시 저장
    urlInputStore.set(userId, {
      userId,
      url,
    });

    logger.info(`User ${userId} input GitHub URL: ${url}`);
  } catch (error) {
    logger.error('Error handling GitHub URL input:', error);
  }
};

/**
 * GitHub 저장소 연결 테스트 처리
 */
export const testGithubConnectionCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const workspaceId = await getWorkspaceId(client);

    // 관리자 권한 확인
    const isUserManager = isManager(workspaceId, userId);
    const isOwner = await isWorkspaceOwner(userId, client);

    if (!isUserManager && !isOwner) {
      logger.warn(`User ${userId} attempted to test GitHub connection without permission`);
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: 'Only administrators can connect GitHub repositories.',
      });
      return;
    }

    // 현재 view의 state에서 URL 가져오기
    const viewBody = body as any;
    const url = viewBody.view?.state?.values?.github_repo_url_input_block?.github_repo_url_input?.value;

    if (!url) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: 'Please enter the GitHub repository URL first.',
      });
      return;
    }

    // URL 파싱
    const repoInfo = parseGithubUrl(url);

    if (!repoInfo) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: 'Invalid GitHub URL. Please enter a URL in the format https://github.com/owner/repo.',
      });
      return;
    }

    // GitHub 연결 테스트
    const githubService = GithubService.getInstance();
    const testResult = await githubService.testConnection({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workspaceId: workspaceId,
      userId: userId,
    });

    logger.info(`GitHub connection test result:`, { testResult, repoInfo });

    if (testResult.success) {
      // 연결 성공 시 저장소 정보 저장
      await storeGithubRepo(workspaceId, repoInfo);

      // 새로운 GitHub 리포지토리에서 파일들을 가져오고 벡터 스토어 업데이트
      let markdownFiles = [];
      try {
        const githubService = GithubService.getInstance();
        // Load markdown files without specifying branch (let GitHub service handle default branch)
        logger.info(`Loading markdown files from ${repoInfo.owner}/${repoInfo.repo}`);
        markdownFiles = await githubService.getAllMarkdownFiles({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          path: repoInfo.path || '',
          workspaceId: workspaceId,
          userId: userId,
        });
        logger.info(`Successfully loaded ${markdownFiles.length} files from repository`);

        // 파일 목록을 워크스페이스 설정에 캐시
        const workspaceStore = new WorkspaceStore();
        const fileList = markdownFiles.map((file) => ({
          name: file.name,
          path: file.path,
        }));
        await workspaceStore.setMarkdownFilesCache(workspaceId, fileList);
        logger.info(`Cached ${fileList.length} markdown files in workspace configuration`);

        await GitHubSyncService.getInstance().syncWorkspaceFromMarkdownFiles({
          workspaceId,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          branch: repoInfo.branch,
          markdownFiles,
          source: 'manual-refresh',
        });

        const vectorStore = VectorStoreService.getInstance();
        // 새로운 파일들로 벡터스토어 설정 (기존 캐시 교체)
        await vectorStore.setMarkdownFiles(markdownFiles, {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          workspaceId,
        });
        logger.info(
          `Vector store rebuilt with ${markdownFiles.length} files from new GitHub repository for workspace ${workspaceId}`,
        );
      } catch (error) {
        logger.error('Error rebuilding vector store after GitHub connection:', error);
      }

      // 1단계: 연결 성공 알림
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: `✅ Repository connected successfully!\n📁 Loading ${markdownFiles.length} markdown files...`,
      });

      // 2단계: 벡터스토어 업데이트 완료 후 알림
      setTimeout(async () => {
        try {
          await client.chat.postEphemeral({
            channel: body.channel?.id || userId,
            user: userId,
            text: `🔄 Vector store updated with ${markdownFiles.length} files.\n🏠 Refreshing home screen...`,
          });
        } catch (error) {
          logger.error('Error sending update message:', error);
        }
      }, 500);

      // 3단계: 홈 화면 자동 새로고침
      setTimeout(async () => {
        try {
          // Create mock event and args for the callback
          const mockEvent = {
            type: 'app_home_opened' as const,
            user: userId,
            tab: 'home' as const,
            event_ts: Date.now().toString(),
          };

          const handlerArgs = {
            client,
            event: mockEvent,
            logger,
            context: {},
            payload: mockEvent,
          };

          // Call the home handler callback directly to refresh the view
          await appHomeOpenedCallback(handlerArgs as any);

          logger.info(`Home screen refreshed for user ${userId} after GitHub connection`);

          // 4단계: 최종 완료 알림
          await client.chat.postEphemeral({
            channel: body.channel?.id || userId,
            user: userId,
            text: `🎉 All done! Repository "${repoInfo.owner}/${repoInfo.repo}" is now connected and ready to use.`,
          });
        } catch (error) {
          logger.error('Error refreshing home view:', error);
          await client.chat.postEphemeral({
            channel: body.channel?.id || userId,
            user: userId,
            text: '🎉 Repository connected successfully! Please refresh the Home tab to see the updated connection.',
          });
        }
      }, 1500);
    } else {
      // 실패 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: `❌ ${testResult.message}`,
      });
    }
  } catch (error) {
    logger.error('Error testing GitHub connection:', error);

    // 오류 메시지 전송
    await client.chat.postEphemeral({
      channel: body.channel?.id || body.user.id,
      user: body.user.id,
      text: 'An error occurred while testing the GitHub connection. Please try again.',
    });
  }
};
