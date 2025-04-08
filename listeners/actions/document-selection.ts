import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockCheckboxesAction,
} from "@slack/bolt";
import {
  getSelectedNodeIds as getStoredSelectedNodeIds,
  clearSelectedNodeIds as clearStoredSelectedNodeIds,
  setSelectedNodeIds,
} from "../../services/document-store";

// 체크박스 액션 핸들러
export const handleDocumentSelection = async ({
  ack,
  body,
  client,
  action,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockCheckboxesAction>) => {
  await ack();

  try {
    const userId = body.user.id;

    // 현재 선택된 모든 노드 ID를 저장하는 Set
    const currentSelectedNodeIds = new Set<string>();

    // body.state.values에서 모든 체크박스 상태 확인
    if (body.state?.values) {
      // 모든 체크박스 블록 순회
      for (const blockId in body.state.values) {
        const block = body.state.values[blockId];

        // document_selection 체크박스인 경우만 처리
        if (
          block.document_selection &&
          block.document_selection.type === "checkboxes"
        ) {
          const selectedOptions =
            block.document_selection.selected_options || [];

          // 선택된 옵션 처리
          for (const option of selectedOptions) {
            try {
              if (option.value) {
                const optionData = JSON.parse(option.value);
                if (optionData.nodeId) {
                  currentSelectedNodeIds.add(optionData.nodeId);
                }
              }
            } catch (error) {
              console.error("체크박스 옵션 파싱 오류:", error);
            }
          }
        }
      }
    }

    // 현재 선택된 모든 노드 ID를 설정
    setSelectedNodeIds(userId, Array.from(currentSelectedNodeIds));
  } catch (error) {
    console.error("문서 선택 처리 중 오류 발생:", error);
  }
};
