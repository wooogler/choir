import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockAction,
} from "@slack/bolt";
import {
  getWorkspaceId,
  isManager,
  isWorkspaceOwner,
  parseGithubUrl,
  storeGithubRepo,
} from "../../services/slack-utils";
import GithubService from "../../services/github";

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
      logger.warn(
        `User ${userId} attempted to input GitHub URL without permission`
      );
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: "관리자만 GitHub 저장소 연동이 가능합니다.",
      });
      return;
    }

    // 입력된 URL 가져오기
    const action = body.actions[0] as unknown as ActionWithValue;
    const url = action.value;

    if (!url) {
      logger.warn("Empty GitHub URL input");
      return;
    }

    // 입력된 URL 임시 저장
    urlInputStore.set(userId, {
      userId,
      url,
    });

    logger.info(`User ${userId} input GitHub URL: ${url}`);
  } catch (error) {
    logger.error("Error handling GitHub URL input:", error);
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
      logger.warn(
        `User ${userId} attempted to test GitHub connection without permission`
      );
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: "관리자만 GitHub 저장소 연동이 가능합니다.",
      });
      return;
    }

    // 저장된 URL 가져오기
    const urlState = urlInputStore.get(userId);

    if (!urlState) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: "먼저 GitHub 저장소 URL을 입력해주세요.",
      });
      return;
    }

    const url = urlState.url;

    // URL 파싱
    const repoInfo = parseGithubUrl(url);

    if (!repoInfo) {
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: "유효하지 않은 GitHub URL입니다. https://github.com/owner/repo 형식의 URL을 입력해주세요.",
      });
      return;
    }

    // GitHub 연결 테스트
    const githubService = GithubService.getInstance();
    const testResult = await githubService.testConnection({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
    });

    if (testResult.success) {
      // 연결 성공 시 저장소 정보 저장
      storeGithubRepo(workspaceId, repoInfo);

      // 성공 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: `🎉 ${testResult.message}\n\n저장소가 성공적으로 연결되었습니다.`,
      });

      // 홈 화면 새로고침
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "홈 화면을 새로고침 중입니다...",
              },
            },
          ],
        },
      });
    } else {
      // 실패 메시지 전송
      await client.chat.postEphemeral({
        channel: body.channel?.id || userId,
        user: userId,
        text: `❌ ${testResult.message}`,
      });
    }
  } catch (error) {
    logger.error("Error testing GitHub connection:", error);

    // 오류 메시지 전송
    await client.chat.postEphemeral({
      channel: body.channel?.id || body.user.id,
      user: body.user.id,
      text: "GitHub 연결 테스트 중 오류가 발생했습니다. 다시 시도해주세요.",
    });
  }
};
