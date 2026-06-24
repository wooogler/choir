import type { App } from '@slack/bolt';

import { createFileSubmissionCallback } from './actions/create-file-submission';
import { createNewSectionAction } from './actions/create-new-section';
import { switchFileForReviewAction } from './actions/file-selection';
import { getEditLinkAction } from './actions/get-edit-link';
import { showCreateFileModalCallback } from './actions/show-create-file-modal';
import { viewAnalyzedMessagesAction } from './actions/view-analyzed-messages';
import { applySelectedToGithubAction } from './apply-document/apply-selected-to-github-action';
import { cancelDocumentUpdatesCallback } from './apply-document/cancel-document-updates-action';
import { handleNewSectionModalSubmission } from './apply-document/new-section-modal-submission';
import { rejectUpdateCallback } from './apply-document/reject-update';
import { applyExtractedKnowledgeCallback } from './extract-knowledge/apply-extracted-knowledge-action';
import { cancelKnowledgeExtractionCallback } from './extract-knowledge/cancel-knowledge-extraction-action';
import { cancelUpdateSuggestionReviewCallback } from './extract-knowledge/cancel-update-suggestion-review-action';
import { editExtractedKnowledgeCallback } from './extract-knowledge/edit-extracted-knowledge-action';
import { openKnowledgeEditManagerModalCallback } from './extract-knowledge/open-knowledge-edit-manager-modal-action';
import { sendUpdateSuggestionToManagerCallback } from './extract-knowledge/send-update-suggestion-to-manager-action';
// Action Callbacks
import { showSuggestionEditorModal } from './suggestions/show-suggestion-editor-modal';
import { suggestUpdatesCallback } from './suggestions/suggest-updates-handler';

import { handleKnowledgeEditManagerModal } from './extract-knowledge/knowledge-edit-manager-modal-view'; // View ID: knowledge_edit_manager_modal
import { handleKnowledgeEditModal } from './extract-knowledge/knowledge-edit-modal-view'; // View ID: knowledge_edit_modal
// View Callbacks
import { handleSuggestionEditorSubmission } from './suggestions/handle-suggestion-editor-submission';

export const registerDocumentUpdateFeature = (app: App) => {
  // Actions
  app.action('edit_update', showSuggestionEditorModal);
  app.action('cancel_document_updates', cancelDocumentUpdatesCallback); // mention-handler.ts 에서도 사용했었음. 여기서 중앙 관리.
  app.action('suggest_updates', suggestUpdatesCallback);
  app.action('skip_suggestion', suggestUpdatesCallback);
  app.action('restart_update_review', suggestUpdatesCallback); // 🔄 Start Over — restart from the first suggestion
  app.action('reject_update', rejectUpdateCallback);
  app.action('apply_to_document', applySelectedToGithubAction);
  app.action('apply_extracted_knowledge', applyExtractedKnowledgeCallback);
  app.action('cancel_knowledge_extraction', cancelKnowledgeExtractionCallback);
  app.action('send_update_suggestion_to_manager', sendUpdateSuggestionToManagerCallback);
  app.action('edit_extracted_knowledge', editExtractedKnowledgeCallback);
  app.action('cancel_update_suggestion_review', cancelUpdateSuggestionReviewCallback);
  app.action('open_knowledge_edit_manager_modal', openKnowledgeEditManagerModalCallback);
  app.action('create_new_section', createNewSectionAction);
  app.action('view_analyzed_messages', viewAnalyzedMessagesAction);
  app.action('switch_file_for_review', switchFileForReviewAction);
  app.action('show_create_file_modal', showCreateFileModalCallback);
  app.action('get_edit_link_for_selected_file', getEditLinkAction);

  // Views
  app.view('update_editor_submission', handleSuggestionEditorSubmission);
  app.view('knowledge_edit_modal', handleKnowledgeEditModal);
  app.view('knowledge_edit_manager_modal', handleKnowledgeEditManagerModal);
  app.view('new_section_modal', handleNewSectionModalSubmission);
  app.view('create_file_modal', createFileSubmissionCallback);
};

export * from './extract-knowledge/update-request-handler';
