import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import {
  getManagers,
  getWorkspaceId,
  getUserName,
  SlackMessage,
  Message,
  formatTimestampToDateString,
} from "../../services/slack-utils";
import {
  generateSessionId,
  storeSessionData,
  SessionType,
} from "../../services/session-store";

const startConsultationCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    logger.info("rawValue type:", typeof rawValue);
    logger.info("rawValue content:", rawValue);
    if (!rawValue) {
      throw new Error("No value provided");
    }

    let value;
    try {
      value = JSON.parse(rawValue);
    } catch (e) {
      // If parsing fails, treat it as a direct consultation ID
      value = {
        stakeholders: [body.user.id],
        validMessages: []
      };
    }
    const { stakeholders, validMessages } = value;
    const uniqueStakeholders = Array.from(new Set(stakeholders)) as string[];

    const userId = body.user.id;

    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(client);

    // 관리자 목록 가져오기
    const managers = getManagers(workspaceId);

    // 현재 사용자가 대화에 참여하는지 확인하고 추가
    const currentUser = body.user.id;
    if (!uniqueStakeholders.includes(currentUser)) {
      uniqueStakeholders.push(currentUser);
    }

    // 관리자도 대화에 자동 포함
    const allParticipants = Array.from(
      new Set([...uniqueStakeholders, ...managers])
    );

    // 이해관계자에서 관리자 제외 (중복 선택 방지)
    const nonManagerStakeholders = uniqueStakeholders.filter(
      (uid) => !managers.includes(uid)
    );

    // 현재 대화 참가자 목록 텍스트 생성
    const stakeholderNames = await Promise.all(
      uniqueStakeholders.map(async (userId) => {
        try {
          const userName = await getUserName(userId, client);
          return `<@${userId}> (${userName})`;
        } catch (error) {
          logger.error(`Error fetching user info for ${userId}:`, error);
          return `<@${userId}>`;
        }
      })
    );

    // 관리자 목록 텍스트 생성
    const managerNames = await Promise.all(
      managers.map(async (managerId) => {
        try {
          const userInfo = await client.users.info({ user: managerId });
          return `<@${managerId}> (${
            userInfo.user?.real_name || userInfo.user?.name || "Unknown"
          })`;
        } catch (error) {
          logger.error(`Error fetching user info for ${managerId}:`, error);
          return `<@${managerId}>`;
        }
      })
    );

    // Slack 블록 생성
    const blocks: any[] = [
      {
        type: "input",
        block_id: "users_block",
        element: {
          type: "multi_users_select",
          action_id: "selected_users",
          initial_users: [...nonManagerStakeholders, ...managers],
          placeholder: {
            type: "plain_text",
            text: "Select users to participate in the direct question",
          },
        },
        label: {
          type: "plain_text",
          text: "Participants",
        },
      },
      {
        type: "divider",
      },
    ];

    // Check if there's only one message or multiple messages
    if (!validMessages || validMessages.length <= 1) {
      // Single message mode - Show input field for question
      const initialMessage = validMessages && validMessages.length > 0 
        ? validMessages.find((msg: SlackMessage) => msg.userId === currentUser)?.text.substring(0, 300) || ""
        : "";

      blocks.push(
        {
          type: "input",
          block_id: "consultation_topic",
          element: {
            type: "plain_text_input",
            action_id: "topic_input",
            placeholder: {
              type: "plain_text",
              text: "Enter your question",
            },
            initial_value: initialMessage,
          },
          label: {
            type: "plain_text",
            text: "Question",
          },
        }
      );
    } else {
      // Multiple messages mode - Display conversation history
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Conversation History*",
          },
        }
      );

      // Format and add previous messages
      const messageBlocks = await Promise.all(
        validMessages.map(async (msg: SlackMessage) => {
          try {
            // Get user name
            let username = "Unknown User";
            try {
              const userInfo = await client.users.info({ user: msg.userId });
              username = userInfo.user?.real_name || userInfo.user?.name || msg.username || "Unknown User";
            } catch (error) {
              logger.error(`Error fetching user info for ${msg.userId}:`, error);
              username = msg.username || "Unknown User";
            }

            // Format timestamp
            const formattedDate = formatTimestampToDateString(msg.ts);

            return {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${username}* • ${formattedDate}\n${msg.text}`,
              },
            };
          } catch (error) {
            logger.error(`Error formatting message for ${msg.userId}:`, error);
            return null;
          }
        }).reverse()
      );

      // Add the message blocks, filtering out any null entries
      blocks.push(...messageBlocks.filter((block) => block !== null));

      // Add input for follow-up question
      blocks.push(
        {
          type: "divider",
        },
        {
          type: "input",
          block_id: "consultation_topic",
          element: {
            type: "plain_text_input",
            action_id: "topic_input",
            placeholder: {
              type: "plain_text",
              text: "Enter your follow-up question",
            },
            initial_value: "",
          },
          label: {
            type: "plain_text",
            text: "Follow-up Question",
          },
        }
      );
    }

    // 관리자 정보 블록 추가
    blocks.push(
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Managers*\nManagers will automatically join the DM:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            managers.length > 0
              ? managerNames.join("\n")
              : "_No managers have been set up_",
        },
      }
    );

    // 현재 대화 참가자 블록 추가
    blocks.push(
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Current Participants*:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            stakeholderNames.length > 0
              ? stakeholderNames.join("\n")
              : "_No participants_",
        },
      }
    );

    // 세션 ID 생성
    const sessionId = generateSessionId("consultation");

    // 전체 데이터를 세션 저장소에 저장
    storeSessionData(
      sessionId,
      {
        participants: allParticipants,
        validMessages: validMessages || [],
      },
      SessionType.CONSULTATION
    );

    // private_metadata에는 세션 ID만 전달
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        private_metadata: JSON.stringify({ sessionId }),
        title: {
          type: "plain_text",
          text: "Ask Direct Question",
        },
        submit: {
          type: "plain_text",
          text: "Start",
        },
        blocks: blocks,
        callback_id: "create_consultation_room",
      },
    });
  } catch (error) {
    logger.error("Error in start consultation callback:", error);
  }
};

export default startConsultationCallback;
