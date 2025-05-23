import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockButtonAction,
} from "@slack/bolt";
import { SessionType } from "services/common";
import { generateSessionId, storeSessionData } from "services/common";
import { generateDocumentDiffs, getSelectedNodeIds, getStoredDocumentUpdates, groupNodesByFile, processFileChanges } from "services/document";
import GithubService from "services/github";
import { formatTimestampToDateString, getManagers, getUserName, getWorkspaceId } from "services/slack";
import { VectorStoreService } from "services/vector/main-service";


const startDiscussionCallback = async ({
  ack,
  body,
  client,
  logger,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockButtonAction>) => {
  await ack();

  try {
    const rawValue = body.actions[0].value;
    logger.info("rawValue", rawValue);
    if (!rawValue) {
      throw new Error("No value provided");
    }

    const value = JSON.parse(rawValue);
    logger.info("Parsed value:", JSON.stringify(value, null, 2));
    
    // 새로운 형식에서 userId를 가져오거나 body.user.id 사용
    const userId = value.userId || body.user.id;
    const stakeholders = value.stakeholders || [];
    const validMessages = value.validMessages || [];
    
    logger.info(`User ID: ${userId}`);
    logger.info(`Stakeholders: ${JSON.stringify(stakeholders)}`);
    logger.info(`Valid messages count: ${validMessages?.length || 0}`);
    const uniqueStakeholders = Array.from(new Set(stakeholders)) as string[];

    // 저장된 모든 document updates 가져오기 (더 이상 selectedNodeIds 필요 없음)
    const documentUpdates = getStoredDocumentUpdates(userId);

    if (!documentUpdates || documentUpdates.length === 0) {
      throw new Error("No document updates found");
    }

    logger.info(`Found ${documentUpdates.length} document updates for user ${userId}`);
    
    // DocumentUpdates를 콘솔에 출력
    console.log("=== DocumentUpdates for Discuss with Members ===");
    console.log(`User ID: ${userId}`);
    console.log(`Number of updates: ${documentUpdates.length}`);
    console.log("Document Updates:", documentUpdates.map(update => ({
      fileName: update.fileName,
      markdownSection: update.markdownSection,
      nodeContent: update.nodeContent,
      updatedNodeContent: update.updatedNodeContent,
      messages: update.messages.map(msg => ({
        username: msg.username,
        text: msg.text
      }))
    })));
    console.log("=== End DocumentUpdates ===");

    // 모든 업데이트 사용 (선택된 노드 필터링 제거)
    const selectedUpdates = documentUpdates;

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

    // 관리자 목록 텍스트 생성 (간단하게)
    const managerText = managers.length > 0 
      ? managers.map(id => `<@${id}>`).join(", ")
      : "_No managers have been set up_";

    // 이해관계자 텍스트 생성 (간단하게)
    const stakeholderText = uniqueStakeholders.length > 0
      ? uniqueStakeholders.map(id => `<@${id}>`).join(", ")
      : "_No participants_";

    // 간단한 블록 생성 (무거운 처리 제거)
    const blocks: any[] = [
      {
        type: "input",
        block_id: "users_block",
        element: {
          type: "multi_users_select",
          action_id: "selected_users",
          initial_users: uniqueStakeholders,
          placeholder: {
            type: "plain_text",
            text: "Select discussion participants",
          },
        },
        label: {
          type: "plain_text",
          text: "Discussion Participants",
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Participating Managers*\nManagers automatically join the discussion:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: managerText,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Current Discussion Participants*\nPeople who sent messages used for document updates:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: stakeholderText,
        },
      }
    ];

    // 세션 ID 생성
    const sessionId = generateSessionId("discussion");
    logger.info(`Generated session ID: ${sessionId}`);

    // 간단한 데이터를 세션 저장소에 저장 (무거운 처리는 모달에서 제출될 때 수행)
    storeSessionData(
      sessionId,
      {
        participants: allParticipants,
        documentUpdates: selectedUpdates,
        validMessages,
        stakeholders: uniqueStakeholders,
      },
      SessionType.DISCUSSION
    );

    logger.info(`Session data stored with ID: ${sessionId}`);

    try {
      // trigger_id 유효성 확인
      const triggerId = body.trigger_id;
      logger.info(`Using trigger_id: ${triggerId}`);

      // private_metadata에는 세션 ID만 전달
      const result = await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          private_metadata: JSON.stringify({ sessionId }),
          title: {
            type: "plain_text",
            text: "Start Discussion",
          },
          submit: {
            type: "plain_text",
            text: "Start",
          },
          blocks: blocks,
          callback_id: "create_discussion_room",
        },
      });

      logger.info(`Modal opened successfully: ${result.view?.id}`);
    } catch (error: any) {
      logger.error(`Error opening modal: ${error.message || error}`);

      // trigger_id 관련 오류인 경우 사용자에게 알림
      if (
        error.data?.error === "exchanged_trigger_id" ||
        error.data?.error === "expired_trigger_id"
      ) {
        try {
          await client.chat.postEphemeral({
            channel: body.channel?.id || "",
            user: body.user.id,
            text: "논의 시작 버튼을 다시 클릭해주세요. 이전 요청이 만료되었습니다.",
          });
        } catch (notifyError: any) {
          logger.error(
            `Error sending notification: ${notifyError.message || notifyError}`
          );
        }
      }
    }
  } catch (error) {
    logger.error("Error in start discussion callback:", error);
  }
};

export default startDiscussionCallback;
