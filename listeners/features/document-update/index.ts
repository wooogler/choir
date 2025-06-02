import type { App } from "@slack/bolt";

// Action Callbacks
import { showUpdateEditorModal } from "./update-editor-modal-action";
import { cancelDocumentUpdatesCallback } from "./cancel-document-updates-action"; 
import { suggestUpdatesCallback } from "./suggest-updates"; // Named export
import { rejectUpdateCallback } from "./reject-update"; // Named export from reject-update.ts
import { applySelectedToGithubAction } from "./update-documents"; // Named export from update-documents.ts

// View Callbacks
import { handleUpdateEditorSubmission } from "./update-editor-modal-view"; // View ID: update_editor_submission
import { handleKnowledgeEditModal } from "./knowledge-edit-modal-view"; // View ID: knowledge_edit_modal
import { handleKnowledgeEditManagerModal } from "./knowledge-edit-manager-modal-view"; // View ID: knowledge_edit_manager_modal

export const registerDocumentUpdateFeature = (app: App) => {
  // Actions
  app.action("edit_update", showUpdateEditorModal);
  app.action("cancel_document_updates", cancelDocumentUpdatesCallback); // mention-handler.ts 에서도 사용했었음. 여기서 중앙 관리.
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("reject_update", rejectUpdateCallback);
  app.action("apply_to_document", applySelectedToGithubAction);
  // "open_knowledge_edit_manager_modal" 액션은 knowledge-edit-manager-modal-view.ts 내부 버튼에서 사용되나, 해당 모달을 여는 것은 App Home 등 다른 곳에서 처리될 수 있음.
  // 여기서는 해당 action ID에 대한 콜백이 없으므로 등록하지 않음. 필요시 해당 콜백을 만들고 등록.

  // Views
  app.view("update_editor_submission", handleUpdateEditorSubmission);
  app.view("knowledge_edit_modal", handleKnowledgeEditModal);
  app.view("knowledge_edit_manager_modal", handleKnowledgeEditManagerModal);
};

// 다른 핸들러(예: message-router)에서 직접 사용할 수 있도록 일부 함수/콜백 export
export * from "./update-request-handler"; // message-router.ts 에서 사용
// suggest-updates, reject-update, update-documents, cancel-document-updates-action은 위에서 import했으므로 중복 export 불필요 