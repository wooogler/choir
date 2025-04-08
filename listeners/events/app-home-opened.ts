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
    // Get workspace information
    const workspaceId = await getWorkspaceId(client);

    // Check if current user is a manager
    const isUserManager = isManager(workspaceId, event.user);

    // Check if user is workspace owner (for initial setup)
    const isOwner = await isWorkspaceOwner(event.user, client);

    // Get current manager list
    const managers = getManagers(workspaceId);

    // Get manager usernames
    const managerBlocks = [];

    if (managers.length > 0) {
      // Manager list header
      managerBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: "✨ Current Managers",
          emoji: true,
        },
      });

      // Get user info for each manager and add to blocks
      for (const managerId of managers) {
        try {
          const userInfo = await client.users.info({ user: managerId });
          const name =
            userInfo.user?.real_name || userInfo.user?.name || "Unknown User";

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
                    text: "Remove Permission",
                    emoji: true,
                  },
                  style: "danger",
                  value: managerId,
                  action_id: "remove_manager_permission",
                  confirm: {
                    title: {
                      type: "plain_text",
                      text: "Remove Manager Permission",
                    },
                    text: {
                      type: "mrkdwn",
                      text: `Do you want to remove manager permission from *<@${managerId}>*?`,
                    },
                    confirm: {
                      type: "plain_text",
                      text: "Remove",
                    },
                    deny: {
                      type: "plain_text",
                      text: "Cancel",
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

    // GitHub repository connection section
    const githubBlocks = [];

    // Show GitHub connection UI only for managers or workspace owners
    if (isUserManager || isOwner) {
      // Get current connected GitHub repository info
      const repoInfo = getGithubRepo(workspaceId);

      githubBlocks.push({
        type: "header",
        text: {
          type: "plain_text",
          text: "🔗 GitHub Repository Connection",
          emoji: true,
        },
      });

      // Show current connection status
      if (repoInfo) {
        githubBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Currently Connected Repository*\n<${repoInfo.url}|${
              repoInfo.owner
            }/${repoInfo.repo}${
              repoInfo.path ? ` (Path: ${repoInfo.path})` : ""
            }>`,
          },
        });
      } else {
        githubBlocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*No repository connected*\nEnter a GitHub repository URL below to connect.",
          },
        });
      }

      // GitHub repository input form
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
            text: "GitHub Repository URL",
          },
          hint: {
            type: "plain_text",
            text: "Enter GitHub repository URL (e.g., https://github.com/username/repo)",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Test Repository Connection",
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

    // Default home view blocks
    const homeBlocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Welcome, <@${event.user}> :house:*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "CHOIR is a tool that automatically updates documents based on Slack conversations.",
        },
      },
      {
        type: "divider",
      },
    ];

    // Manager permission management section
    const managerManagementBlocks = [];

    // Show management UI only for managers or workspace owners
    if (isUserManager || isOwner) {
      managerManagementBlocks.push(
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "👑 Manager Permission Management",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Managers can grant and revoke manager permissions for other users.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "users_select",
              placeholder: {
                type: "plain_text",
                text: "Select User",
                emoji: true,
              },
              action_id: "select_user_for_permission",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Grant Manager Permission",
                emoji: true,
              },
              style: "primary",
              action_id: "add_manager_permission",
              confirm: {
                title: {
                  type: "plain_text",
                  text: "Grant Manager Permission",
                },
                text: {
                  type: "mrkdwn",
                  text: "Do you want to grant manager permission to the selected user?",
                },
                confirm: {
                  type: "plain_text",
                  text: "Grant",
                },
                deny: {
                  type: "plain_text",
                  text: "Cancel",
                },
              },
            },
          ],
        },
        {
          type: "divider",
        }
      );

      // Add vector store management section
      managerManagementBlocks.push(
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🔍 Vector Store Management",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "You can use vector store diagnosis and recovery features. Use these when there are issues with document search or update suggestion features.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Vector Store Diagnosis",
                emoji: true,
              },
              style: "primary",
              action_id: "diagnose_vector_store",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Rebuild Cache",
                emoji: true,
              },
              action_id: "rebuild_vector_cache",
              confirm: {
                title: {
                  type: "plain_text",
                  text: "Rebuild Cache",
                },
                text: {
                  type: "mrkdwn",
                  text: "Do you want to rebuild the vector store cache? This process may take a few minutes.",
                },
                confirm: {
                  type: "plain_text",
                  text: "Rebuild",
                },
                deny: {
                  type: "plain_text",
                  text: "Cancel",
                },
              },
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Emergency Reset",
                emoji: true,
              },
              style: "danger",
              action_id: "reset_vector_store",
              confirm: {
                title: {
                  type: "plain_text",
                  text: "Emergency Reset",
                },
                text: {
                  type: "mrkdwn",
                  text: "⚠️ Do you want to completely reset and rebuild the vector store? This action cannot be undone and may take a few minutes.",
                },
                confirm: {
                  type: "plain_text",
                  text: "Reset",
                },
                deny: {
                  type: "plain_text",
                  text: "Cancel",
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

    // Final home view blocks
    const blocks = [
      ...homeBlocks,
      ...githubBlocks,
      ...managerManagementBlocks,
      ...managerBlocks,
    ];

    // Publish home view
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
