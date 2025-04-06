import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  getManagers,
  isManager,
  getWorkspaceId,
  isWorkspaceOwner,
  getGithubRepo,
} from "../../services/slack-utils";

const appHomeOpenedCallback = async ({
  client,
  event,
  logger,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_home_opened">) => {
  // Ignore the `app_home_opened` event for anything but the Home tab
  if (event.tab !== "home") return;

  try {
    // 워크스페이스 정보 가져오기
    const workspaceId = await getWorkspaceId(client);

    // 현재 사용자가 관리자인지 확인
    const isUserManager = isManager(workspaceId, event.user);

    // 워크스페이스 소유자 여부 확인 (초기 설정을 위해)
    const isOwner = await isWorkspaceOwner(event.user, client);

    // 현재 관리자 목록 가져오기
    const managers = getManagers(workspaceId);

    // 관리자 사용자 이름 가져오기
    const managerBlocks = [];

    if (managers.length > 0) {
      // 관리자 리스트 헤더
      managerBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: "✨ 현재 관리자",
          emoji: true,
        },
      });

      // 각 관리자에 대한 사용자 정보를 가져와서 블록에 추가
      for (const managerId of managers) {
        try {
          const userInfo = await client.users.info({ user: managerId });
          const name =
            userInfo.user?.real_name ||
            userInfo.user?.name ||
            "알 수 없는 사용자";

          managerBlocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `• <@${managerId}> (${name})`,
            },
            accessory: isUserManager
              ? {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "권한 제거",
                    emoji: true,
                  },
                  style: "danger",
                  value: managerId,
                  action_id: "remove_manager_permission",
                  confirm: {
                    title: {
                      type: "plain_text",
                      text: "관리자 권한 제거",
                    },
                    text: {
                      type: "mrkdwn",
                      text: `*<@${managerId}>*의 관리자 권한을 제거하시겠습니까?`,
                    },
                    confirm: {
                      type: "plain_text",
                      text: "제거",
                    },
                    deny: {
                      type: "plain_text",
                      text: "취소",
                    },
                  },
                }
              : null,
          });
        } catch (error) {
          logger.error(`Failed to get user info for ${managerId}:`, error);
        }
      }

      managerBlocks.push({
        type: "divider",
      });
    }

    // GitHub 저장소 연동 섹션
    const githubBlocks = [];

    // 사용자가 관리자이거나 워크스페이스 소유자인 경우에만 GitHub 연동 UI 표시
    if (isUserManager || isOwner) {
      // 현재 연결된 GitHub 저장소 정보 가져오기
      const repoInfo = getGithubRepo(workspaceId);

      githubBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: "🔗 GitHub 저장소 연동",
          emoji: true,
        },
      });

      // 현재 연결 상태 표시
      if (repoInfo) {
        githubBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*현재 연결된 저장소*\n<${repoInfo.url}|${repoInfo.owner}/${
              repoInfo.repo
            }${repoInfo.path ? ` (경로: ${repoInfo.path})` : ""}>`,
          },
        });
      } else {
        githubBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*현재 연결된 저장소가 없습니다*\n아래에 GitHub 저장소 URL을 입력하여 연결하세요.",
          },
        });
      }

      // GitHub 저장소 입력 양식
      githubBlocks.push(
        {
          type: "input",
          dispatch_action: true,
          element: {
            type: "plain_text_input",
            action_id: "github_repo_url_input",
            placeholder: {
              type: "plain_text",
              text: "https://github.com/username/repo",
            },
          },
          label: {
            type: "plain_text",
            text: "GitHub 저장소 URL",
          },
          hint: {
            type: "plain_text",
            text: "GitHub 저장소 URL을 입력하세요 (예: https://github.com/username/repo)",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "저장소 연결 테스트",
                emoji: true,
              },
              style: "primary",
              action_id: "test_github_connection",
            },
          ],
        },
        {
          type: "divider",
        }
      );
    }

    // 기본 홈 뷰 블록
    const homeBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*환영합니다, <@${event.user}> :house:*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "CHOIR는 Slack 대화 내용을 기반으로 문서를 자동으로 업데이트하는 도구입니다.",
        },
      },
      {
        type: "divider",
      },
    ];

    // 관리자 권한 관리 섹션
    const managerManagementBlocks = [];

    // 사용자가 관리자이거나 워크스페이스 소유자인 경우에만 관리 UI 표시
    if (isUserManager || isOwner) {
      managerManagementBlocks.push(
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "👑 관리자 권한 관리",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "관리자는 다른 사용자에게 관리자 권한을 부여하고 제거할 수 있습니다.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "users_select",
              placeholder: {
                type: "plain_text",
                text: "사용자 선택",
                emoji: true,
              },
              action_id: "select_user_for_permission",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "관리자 권한 부여",
                emoji: true,
              },
              style: "primary",
              action_id: "add_manager_permission",
              confirm: {
                title: {
                  type: "plain_text",
                  text: "관리자 권한 부여",
                },
                text: {
                  type: "mrkdwn",
                  text: "선택한 사용자에게 관리자 권한을 부여하시겠습니까?",
                },
                confirm: {
                  type: "plain_text",
                  text: "부여",
                },
                deny: {
                  type: "plain_text",
                  text: "취소",
                },
              },
            },
          ],
        },
        {
          type: "divider",
        }
      );
    }

    // 최종 홈 뷰 블록 구성
    const blocks = [
      ...homeBlocks,
      ...githubBlocks,
      ...managerManagementBlocks,
      ...managerBlocks,
    ];

    // 홈 뷰 게시
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: blocks,
      },
    });
  } catch (error) {
    logger.error(error);
  }
};

export default appHomeOpenedCallback;
