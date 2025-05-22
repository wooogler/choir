import { BlockButtonAction } from "@slack/bolt";
import { 
  updateDocumentContent, 
  convertMarkdownToSlackText,
  getStoredDocumentUpdates,
  getStoredThreadTs,
  getStoredChannelId,
} from "../../services/document";
import { createDiffBlock } from "../../services/slack";
import suggestUpdatesCallback from "../document-handlers/suggest-updates";

/**
 * 문서 업데이트 제안 편집 모달을 표시합니다.
 */
export const showUpdateEditorModal = async ({ ack, body, client }: any) => {
  try {
    // 액션 확인
    await ack();

    // 버튼의 value 확인
    const value = body.actions?.[0]?.value;
    if (!value) {
      throw new Error("버튼 값을 찾을 수 없습니다");
    }

    // 버튼의 value에서 필요한 정보 파싱
    const actionValue = JSON.parse(value);
    const { nodeContent, updatedNodeContent } = actionValue;

    // 필수 값 확인
    if (!nodeContent || !updatedNodeContent) {
      console.log("nodeContent", nodeContent);
      console.log("updatedNodeContent", updatedNodeContent);
      throw new Error("필수 콘텐츠 값이 누락되었습니다");
    }

    // 모달 화면 생성
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "update_editor_submission",
        private_metadata: JSON.stringify({ 
          messageTs: body.message.ts,
          channelId: body.channel.id,
          nodeContent,
          index: actionValue.index,
          fileName: actionValue.fileName,
          nodeId: actionValue.nodeId
        }),
        title: {
          type: "plain_text",
          text: "Edit Update Suggestion",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Original Content:*",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: nodeContent,
            },
          },
          {
            type: "input",
            block_id: "updated_content_block",
            label: {
              type: "plain_text",
              text: "Updated Content",
            },
            element: {
              type: "plain_text_input",
              action_id: "updated_content_input",
              multiline: true,
              initial_value: updatedNodeContent,
            },
          }
        ],
        submit: {
          type: "plain_text",
          text: "Save Changes",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
      },
    });
  } catch (error) {
    console.error("Error showing update editor modal:", error);
    
    // 사용자에게 에러 메시지 전송
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });

      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `업데이트 편집기를 열 수 없습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
        });
      }
    } catch (dmError) {
      console.error("Error sending error message:", dmError);
    }
  }
};

/**
 * 모달에서 제출된 내용을 처리합니다.
 */
export const handleUpdateEditorSubmission = async ({ ack, body, client }: any) => {
  try {
    // 제출 확인
    await ack();

    // 메타데이터에서 정보 가져오기
    const { messageTs, channelId, nodeContent, index, fileName, nodeId } = JSON.parse(body.view.private_metadata);
    
    // 입력된 업데이트 내용 가져오기
    const updatedContent = body.view.state.values.updated_content_block.updated_content_input.value;

    // 새로운 diff 블록 생성
    const oldSlackText = await convertMarkdownToSlackText(nodeContent);
    const newSlackText = await convertMarkdownToSlackText(updatedContent);
    const diffBlock = createDiffBlock(oldSlackText, newSlackText);

    // 기존 메시지 가져오기
    const result = await client.conversations.history({
      channel: channelId,
      latest: messageTs,
      inclusive: true,
      limit: 1
    });

    if (!result.messages || result.messages.length === 0) {
      throw new Error("기존 메시지를 찾을 수 없습니다");
    }

    const message = result.messages[0];
    const blocks = JSON.parse(JSON.stringify(message.blocks || [])); // 깊은 복사로 원본 블록 보존

    // diff 블록 업데이트 - rich_text 타입 블록 찾기
    const diffBlockIndex = blocks.findIndex((block: any) => 
      block.type === "rich_text" && 
      block.elements?.[0]?.type === "rich_text_section"
    );

    if (diffBlockIndex !== -1) {
      blocks[diffBlockIndex] = diffBlock;

      // Edit Update 버튼의 value만 업데이트
      const actionsBlockIndex = blocks.findIndex((block: any) => 
        block.type === "actions" && 
        block.elements?.some((element: any) => element.action_id === "edit_update")
      );

      if (actionsBlockIndex !== -1) {
        const actionsBlock = blocks[actionsBlockIndex];
        actionsBlock.elements = actionsBlock.elements.map((element: any) => {
          if (element.action_id === "edit_update") {
            // 버튼의 다른 속성은 그대로 유지하고 value만 업데이트
            return {
              ...element,
              value: JSON.stringify({
                ...JSON.parse(element.value),
                nodeContent,
                updatedNodeContent: updatedContent
              })
            };
          }
          return {...element}; // 다른 버튼들도 깊은 복사
        });
      }

      // 메시지 업데이트
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: blocks,
        text: message.text || "Document Update Suggestion"
      });

      // 문서 업데이트 저장
      const userId = body.user.id;
      updateDocumentContent(userId, index, updatedContent);
    } else {
      throw new Error("업데이트할 diff 블록을 찾을 수 없습니다");
    }

  } catch (error) {
    console.error("Error handling update editor submission:", error);
    
    // 사용자에게 에러 메시지 전송
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });

      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `업데이트 제안 수정 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
        });
      }
    } catch (dmError) {
      console.error("Error sending error message:", dmError);
    }
  }
}; 