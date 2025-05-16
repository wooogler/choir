import type {
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockCheckboxesAction,
} from "@slack/bolt";
import { setSelectedNodeIds } from "services/document";

const handleDocumentSelection = async ({
  ack,
  body,
}: AllMiddlewareArgs & SlackActionMiddlewareArgs<BlockCheckboxesAction>) => {
  await ack();

  try {
    const userId = body.user.id;
    const selectedOptions = body.actions[0].selected_options;

    if (!selectedOptions) {
      return;
    }

    // 선택된 노드 ID 추출
    const selectedNodeIds = selectedOptions
      .map((option) => {
        try {
          const value = JSON.parse(option.value ?? '{}');
          return value.nodeId as string;
        } catch (error) {
          console.error("Error parsing option value:", error);
          return null;
        }
      })
      .filter((nodeId): nodeId is string => nodeId !== null);

    // 선택된 노드 ID 저장
    setSelectedNodeIds(userId, selectedNodeIds);
  } catch (error) {
    console.error("Error handling document selection:", error);
  }
};

export { handleDocumentSelection };
