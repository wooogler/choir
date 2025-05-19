import { BlockButtonAction } from "@slack/bolt";
import { 
  updateDocumentContent, 
  convertMarkdownToSlackText, 
  getStoredDocumentUpdates,
  getStoredThreadTs,
  getStoredChannelId,
  generateDocumentUpdateBlocks
} from "../../services/document";
import { createDiffBlock } from "../../services/slack";

/**
 * 문서 업데이트 제안 편집 모달을 표시합니다.
 */
export const showUpdateEditorModal = async ({ ack, body, client }: any) => {
  try {
    // 액션 확인
    await ack();

    // 버튼의 value에서 필요한 정보 파싱
    const actionValue = JSON.parse(body.actions[0].value);
    const { index, nodeContent, updatedNodeContent } = actionValue;

    // 원본 콘텐츠와 업데이트된 콘텐츠로 diff 블록 생성
    const oldSlackText = await convertMarkdownToSlackText(nodeContent);
    const newSlackText = await convertMarkdownToSlackText(updatedNodeContent);
    const diffBlock = createDiffBlock(oldSlackText, newSlackText);

    // 모달 화면 생성
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "update_editor_submission",
        private_metadata: JSON.stringify({ 
          index,
          nodeContent
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
              text: oldSlackText,
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
          },
          {
            type: "actions",
            block_id: "preview_actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Preview Update",
                  emoji: true,
                },
                style: "primary",
                action_id: "preview_update",
                value: JSON.stringify({ index }),
              }
            ]
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Update Preview:*",
            },
          },
          // 초기 diffBlock 표시
          diffBlock
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
  }
};

/**
 * 미리보기 업데이트 버튼 액션을 처리합니다.
 */
export const handlePreviewUpdate = async ({ ack, body, client }: any) => {
  try {
    // 액션 확인
    await ack();

    // 현재 모달 정보 가져오기
    const currentView = body.view;
    const { nodeContent } = JSON.parse(currentView.private_metadata);
    const updatedContent = currentView.state.values.updated_content_block.updated_content_input.value;

    // 원본 콘텐츠와 업데이트된 콘텐츠로 diff 블록 생성
    const oldSlackText = await convertMarkdownToSlackText(nodeContent);
    const newSlackText = await convertMarkdownToSlackText(updatedContent);
    const diffBlock = createDiffBlock(oldSlackText, newSlackText);

    // 모달 뷰 업데이트
    const blocks = [...currentView.blocks];
    
    // 마지막 블록(기존 diffBlock)을 새로운 diffBlock으로 교체
    blocks[blocks.length - 1] = diffBlock;

    await client.views.update({
      view_id: currentView.id,
      view: {
        type: "modal",
        callback_id: currentView.callback_id,
        private_metadata: currentView.private_metadata,
        title: currentView.title,
        blocks: blocks,
        submit: currentView.submit,
        close: currentView.close,
      },
    });
  } catch (error) {
    console.error("Error handling preview update:", error);
  }
};

/**
 * 모달에서 제출된 내용을 처리합니다.
 */
export const handleUpdateEditorSubmission = async ({ ack, body, client }: any) => {
  try {
    // 제출 확인
    await ack();

    // 메타데이터에서 index 가져오기
    const { index } = JSON.parse(body.view.private_metadata);
    
    // 입력된 업데이트 내용 가져오기
    const updatedContent = body.view.state.values.updated_content_block.updated_content_input.value;

    // 문서 업데이트 저장
    const userId = body.user.id;
    const success = updateDocumentContent(userId, index, updatedContent);

    if (success) {
      // 사용자의 documentUpdates 가져오기
      const documentUpdates = getStoredDocumentUpdates(userId);
      
      // 공통 유틸리티 함수를 사용하여 블록 생성
      const newBlocks = await generateDocumentUpdateBlocks(userId, documentUpdates, client);
      
      if (newBlocks) {
        // thread_ts와 channel_id 가져오기 (이전 메시지를 찾기 위해)
        const threadTs = getStoredThreadTs(userId);
        const channelId = getStoredChannelId(userId);
        
        if (threadTs && channelId) {
          // 원래 스레드에 메시지 보내기
          await client.chat.postEphemeral({
            user: userId,
            channel: channelId,
            thread_ts: threadTs,
            blocks: newBlocks,
            text: "Document Updates Suggestions has been refreshed."
          });
          
          console.log(`메시지를 기존 스레드(${threadTs})와 채널(${channelId})에 전송했습니다.`);
        } else {
          console.log("스레드나 채널 정보를 찾을 수 없습니다:", { threadTs, channelId });
          
          // DM으로 메시지 보내기
          try {
            const conversationsResult = await client.conversations.open({
              users: userId
            });
            
            const dmChannelId = conversationsResult.channel?.id;
            
            if (!dmChannelId) {
              throw new Error("DM 채널을 찾을 수 없습니다");
            }
            
            await client.chat.postEphemeral({
              user: userId,
              channel: dmChannelId,
              blocks: newBlocks,
              text: "Document Updates Suggestions has been refreshed."
            });
            
            console.log(`메시지를 DM 채널(${dmChannelId})에 전송했습니다.`);
          } catch (dmError) {
            console.error("DM 채널 사용 시 오류:", dmError);
            
            // 마지막 시도: 기본 메시지만 표시
            const dmOpenResult = await client.conversations.open({
              users: userId
            });
            
            await client.chat.postMessage({
              channel: dmOpenResult.channel?.id as string,
              text: "업데이트 제안이 성공적으로 수정되었습니다. 원래 대화로 돌아가세요."
            });
          }
        }
      } else {
        // 블록 생성 실패 시 기본 메시지 표시
        const dmOpenResult = await client.conversations.open({
          users: userId
        });
        
        await client.chat.postMessage({
          channel: dmOpenResult.channel?.id as string,
          text: "업데이트 제안이 성공적으로 수정되었습니다. 원래 대화로 돌아가세요."
        });
      }
    } else {
      // 실패 시 에러 메시지
      // DM으로 메시지 보내기
      const dmOpenResult = await client.conversations.open({
        users: userId
      });
      
      await client.chat.postMessage({
        channel: dmOpenResult.channel?.id as string,
        text: "업데이트 제안 수정 중 오류가 발생했습니다. 나중에 다시 시도해주세요."
      });
    }
  } catch (error) {
    console.error("Error handling update editor submission:", error);
  }
}; 