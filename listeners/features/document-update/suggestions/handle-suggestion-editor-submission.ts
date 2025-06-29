import type { AllMiddlewareArgs, SlackViewMiddlewareArgs } from "@slack/bolt";
import { 
  updateDocumentContent, 
  convertMarkdownToSlackText,
} from "../../../../services/document"; // 경로 수정
import { createDiffBlock } from "../../../../services/slack"; // 경로 수정
import { createAppendSuggestionBlock } from "../../../../services/document/update-processor";
import { logModalSubmit } from "../../../../services/common/user-interaction-logger";

/**
 * 모달에서 제출된 내용을 처리합니다.
 */
export const handleSuggestionEditorSubmission = async ({
  ack,
  body,
  view,
  client,
}: AllMiddlewareArgs & SlackViewMiddlewareArgs) => {
  const startTime = Date.now();
  
  try {
    // 제출 확인
    await ack();

    // 메타데이터에서 정보 가져오기
    const { messageTs, channelId, nodeContent, editableContent, suggestionType, index, fileName, nodeId } = JSON.parse(view.private_metadata);
    
    if (!messageTs || !channelId) {
      throw new Error("필수 메타데이터가 누락되었습니다");
    }
    
    // 입력된 업데이트 내용 가져오기
    const updatedContent = view.state.values.updated_content_block.updated_content_input.value as string;

    // Edit 버튼으로 변경된 내용을 콘솔에 출력
    console.log("=== Document Update Edit ===");
    console.log(`File: ${fileName}`);
    console.log(`Section: ${nodeId}`);
    console.log(`Suggestion Type: ${suggestionType || "UPDATE"}`);
    console.log("Content updated successfully");
    console.log("=== End Document Update Edit ===");

    // suggestionType에 따라 다른 블록 생성
    let newDiffBlock;
    if (suggestionType === "APPEND") {
      // APPEND의 경우 appendSuggestionBlock 생성
      newDiffBlock = createAppendSuggestionBlock(nodeContent, updatedContent);
    } else {
      // UPDATE의 경우 기존 diff 블록 생성
      const oldSlackText = await convertMarkdownToSlackText(nodeContent);
      const newSlackText = await convertMarkdownToSlackText(updatedContent);
      newDiffBlock = createDiffBlock(oldSlackText, newSlackText);
    }

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
    const blocks = JSON.parse(JSON.stringify(message.blocks || []));

    // diff 블록 업데이트 - rich_text 타입 블록 찾기 (rich_text_quote 또는 rich_text_section)
    const diffBlockIndex = blocks.findIndex((block: any) => 
      block.type === "rich_text" && 
      (block.elements?.[0]?.type === "rich_text_quote" || block.elements?.[0]?.type === "rich_text_section")
    );

    if (diffBlockIndex !== -1) {
      blocks[diffBlockIndex] = newDiffBlock;

      // Edit Update 버튼의 value만 업데이트
      const actionsBlockIndex = blocks.findIndex((block: any) => 
        block.type === "actions" && 
        block.elements?.some((element: any) => element.action_id === "edit_update")
      );

      if (actionsBlockIndex !== -1) {
        const actionsBlock = blocks[actionsBlockIndex];
        actionsBlock.elements = actionsBlock.elements.map((element: any) => {
          if (element.action_id === "edit_update") {
            const originalValue = JSON.parse(element.value);
            
            // suggestionType에 따라 다른 필드 업데이트
            if (suggestionType === "APPEND") {
              return {
                ...element,
                value: JSON.stringify({
                  ...originalValue,
                  originalLastNodeContent: nodeContent,
                  appendedNodeContent: updatedContent
                })
              };
            } else {
              return {
                ...element,
                value: JSON.stringify({
                  ...originalValue,
                  nodeContent,
                  updatedNodeContent: updatedContent
                })
              };
            }
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

      // 로그: 성공
      logModalSubmit(
        userId,
        'unknown',
        'update_editor_submission',
        Date.now() - startTime,
        true,
        {
          messageTs,
          channelId,
          fileName,
          nodeId,
          suggestionType: suggestionType || "UPDATE",
          index,
          originalContentLength: nodeContent?.length || 0,
          updatedContentLength: updatedContent?.length || 0,
          diffBlockFound: diffBlockIndex !== -1,
          actionsBlockFound: actionsBlockIndex !== -1
        }
      );

    } else {
      throw new Error("Diff 블록을 찾을 수 없습니다");
    }

  } catch (error) {
    console.error("Error handling suggestion editor submission:", error);
    
    // 사용자에게 에러 메시지 전송
    try {
      const dmResult = await client.conversations.open({
        users: body.user.id
      });

      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: `수정 사항을 저장할 수 없습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
        });
      }
    } catch (dmError) {
      console.error("Error sending error message:", dmError);
    }

    // 로그: 실패
    logModalSubmit(
      body.user.id,
      'unknown',
      'update_editor_submission',
      Date.now() - startTime,
      false,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        errorStack: error instanceof Error ? error.stack : undefined,
        privateMetadata: view.private_metadata
      }
    );
  }
}; 