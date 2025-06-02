import type { App } from "@slack/bolt";

// Action Callbacks
import { showSuggestionEditorModal } from "./suggestions/show-suggestion-editor-modal";
import { cancelDocumentUpdatesCallback } from "./apply-document/cancel-document-updates-action"; 
import { suggestUpdatesCallback } from "./suggestions/suggest-updates"; // Named export
import { rejectUpdateCallback } from "./apply-document/reject-update"; // Named export from reject-update.ts
import { applySelectedToGithubAction } from "./apply-document/update-documents"; // Named export from update-documents.ts

// View Callbacks
import { handleSuggestionEditorSubmission } from "./suggestions/handle-suggestion-editor-submission";
import { handleKnowledgeEditModal } from "./extract-knowledge/knowledge-edit-modal-view"; // View ID: knowledge_edit_modal
import { handleKnowledgeEditManagerModal } from "./extract-knowledge/knowledge-edit-manager-modal-view"; // View ID: knowledge_edit_manager_modal

export const registerDocumentUpdateFeature = (app: App) => {
  // Actions
  app.action("edit_update", showSuggestionEditorModal);
  app.action("cancel_document_updates", cancelDocumentUpdatesCallback); // mention-handler.ts 에서도 사용했었음. 여기서 중앙 관리.
  app.action("suggest_updates", suggestUpdatesCallback);
  app.action("reject_update", rejectUpdateCallback);
  app.action("apply_to_document", applySelectedToGithubAction);

  // Views
  app.view("update_editor_submission", handleSuggestionEditorSubmission);
  app.view("knowledge_edit_modal", handleKnowledgeEditModal);
  app.view("knowledge_edit_manager_modal", handleKnowledgeEditManagerModal);
};

export * from "./extract-knowledge/update-request-handler";