import { convertMarkdownToSlackText } from "./";
import { DocumentUpdate, getSelectedNodeIds } from "./document-store";
import { createDiffBlock, getManagers, getWorkspaceId } from "../slack";

/**
 * 문서 업데이트 제안 블록 UI를 생성합니다.
 * suggest-updates.ts와 update-editor.ts에서 공통으로 사용하는 함수입니다.
 */
export async function generateDocumentUpdateBlocks(
  userId: string,
  documentUpdates: DocumentUpdate[],
  client: any
) {
  try {
    // 변경사항이 있는 문서만 필터링
    const documentUpdatesWithChanges = documentUpdates.filter(
      (doc) => doc.hasChanges && doc.index >= 0
    );
    
    // 변경사항이 없는 경우
    if (documentUpdatesWithChanges.length === 0) {
      return null;
    }
    
    // 워크스페이스 ID 가져오기
    const workspaceId = await getWorkspaceId(client);
    
    // 관리자 목록 가져오기
    const managers = getManagers(workspaceId);
    
    // 현재 사용자가 관리자인지 확인
    const isManager = managers.includes(userId);
    
    // 이전에 선택된 노드 ID 가져오기
    const selectedNodeIds = getSelectedNodeIds(userId);
    
    // 블록 생성
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Document Updates Suggestions",
          emoji: true,
        },
      },
      {
        type: "divider",
      },
    ];
    
    // 각 문서에 대한 섹션 추가
    for (const doc of documentUpdatesWithChanges) {
      // diffBlock이 없는 경우 (업데이트로 인해) 새로 생성
      if (!doc.diffBlock || doc.oldContent !== await convertMarkdownToSlackText(doc.nodeContent) || doc.newContent !== await convertMarkdownToSlackText(doc.updatedNodeContent)) {
        const oldSlackText = await convertMarkdownToSlackText(doc.nodeContent);
        const newSlackText = await convertMarkdownToSlackText(doc.updatedNodeContent);
        doc.diffBlock = createDiffBlock(oldSlackText, newSlackText);
        doc.oldContent = oldSlackText.substring(0, Math.min(oldSlackText.length, 1500));
        doc.newContent = newSlackText.substring(0, Math.min(newSlackText.length, 1500));
      }
      
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*File:* <${doc.githubUrl}|${doc.fileName}>\n*Section:* ${doc.markdownSection}`,
          },
        },
        {
          type: "divider",
        },
        doc.diffBlock,
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Edit Update",
                emoji: true,
              },
              action_id: "edit_update",
              value: JSON.stringify({
                index: doc.index,
                nodeContent: doc.nodeContent,
                updatedNodeContent: doc.updatedNodeContent
              }),
            }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Would you like to update this document?",
          },
          accessory: {
            type: "checkboxes",
            action_id: "document_selection",
            options: [
              {
                text: {
                  type: "mrkdwn",
                  text: "Update",
                },
                value: JSON.stringify({
                  index: doc.index,
                  nodeId: doc.nodeId,
                }),
              },
            ],
            initial_options: selectedNodeIds.includes(doc.nodeId) ? [
              {
                text: {
                  type: "mrkdwn",
                  text: "Update",
                },
                value: JSON.stringify({
                  index: doc.index,
                  nodeId: doc.nodeId,
                }),
              },
            ] : [],
          },
        },
        {
          type: "divider",
        }
      );
    }
    
    // 선택한 문서에 대한 액션 버튼
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Actions for selected documents:*",
        },
      },
      {
        type: "actions",
        block_id: "document_actions",
        elements: [
          ...(isManager
            ? [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Apply to Document",
                    emoji: true,
                  },
                  style: "primary",
                  action_id: "apply_selected_to_github",
                  value: JSON.stringify({}),
                },
              ]
            : []),
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Start Discussion",
              emoji: true,
            },
            action_id: "start_discussion",
            value: JSON.stringify({}),
          },
        ],
      }
    );
    
    return blocks;
  } catch (error) {
    console.error("Error generating document updates blocks:", error);
    return null;
  }
} 