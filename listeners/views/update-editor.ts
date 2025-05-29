import type { App, AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { 
  updateDocumentContent, 
  convertMarkdownToSlackText,
} from "../../services/document";
import { createDiffBlock } from "../../services/slack";

/**
 * 모달에서 제출된 내용을 처리합니다.
 */
const handleUpdateEditorSubmission = async ({
  ack,
  body,
  view,
  client,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  try {
    // 제출 확인
    await ack();

    // 메타데이터에서 정보 가져오기
    const { messageTs, channelId, nodeContent, index, fileName, nodeId } = JSON.parse(view.private_metadata);
    
    if (!messageTs || !channelId) {
      throw new Error("필수 메타데이터가 누락되었습니다");
    }
    
    // 입력된 업데이트 내용 가져오기
    const updatedContent = view.state.values.updated_content_block.updated_content_input.value as string;

    // Edit 버튼으로 변경된 내용을 콘솔에 출력
    console.log("=== Document Update Edit ===");
    console.log(`File: ${fileName}`);
    console.log(`Section: ${nodeId}`);
    console.log("Content updated successfully");
    console.log("=== End Document Update Edit ===");

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

      console.log(`Message updated for user ${userId}, index ${index}`);
    } else {
      throw new Error("Diff 블록을 찾을 수 없습니다");
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
          text: `업데이트 편집을 완료할 수 없습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
        });
      }
    } catch (dmError) {
      console.error("Error sending error message:", dmError);
    }
  }
};

const register = (app: App) => {
  app.view("update_editor_submission", handleUpdateEditorSubmission);
};

export default { register };