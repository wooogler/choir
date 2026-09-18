/**
 * The viewer's English catalog, and with it the set of keys the SPA may use.
 *
 * English is the source of truth: `MessageKey` is derived from this object, so
 * a component ships its strings here first and every other locale is a partial
 * overlay on top of it.
 *
 * Catalogs are plain data on purpose — no imports, no helpers — so they can be
 * read, diffed and (later) machine-translated without running any code. The
 * `as const` is what gives `MessageKey` its compile-time key safety. Holes are
 * written `{name}`, never `${name}`: a template literal would be filled in by
 * whoever wrote this file, which defeats the point of shipping strings a
 * translator can edit.
 */

export const en = {
  // ── Shared ──────────────────────────────────────────────────────────────
  'common.button.cancel': 'Cancel',
  'common.button.close': 'Close',
  'common.loading': 'Loading…',
  'common.unknownUser': 'Unknown',

  // ── App shell (App.tsx) ─────────────────────────────────────────────────
  'app.invalidUrl': 'Invalid URL. Expected {path}',

  // ── Document header (DocHeader.tsx) ─────────────────────────────────────
  'header.sidebar.show': 'Show sidebar',
  'header.sidebar.hide': 'Hide sidebar',

  // ── File sidebar (FilesSidebar.tsx) ─────────────────────────────────────
  'sidebar.aria.documents': 'Documents',
  'sidebar.repo.fallback': 'Repository',
  'sidebar.files': '{count} files',
  'sidebar.filesOnBranch': '{count} files on {branch}',
  'sidebar.insights': 'Insights',
  'sidebar.newDocument': 'New document',

  // ── Floating outline (FloatingToc.tsx) ──────────────────────────────────
  'toc.aria.label': 'Table of contents',

  // ── Document viewer (DocViewer.tsx) ─────────────────────────────────────
  'viewer.error.prefix': 'Error:',
  'viewer.error.signInRequired': 'Sign in required',
  'viewer.error.loadFailed': 'Failed to load document',
  'viewer.error.saveFailed': 'Failed to save',
  'viewer.error.deleteFailed': 'Failed to delete',
  'viewer.error.createFailed': 'Failed to create the document',
  'viewer.confirm.unsavedChanges': 'Unsaved changes will be lost. Continue?',
  'viewer.confirm.discard': 'Discard all unsaved changes?',
  'viewer.loadingDocument': 'Loading document…',
  'viewer.landing.noDocuments':
    'This workspace has no markdown documents yet. Connect a repository from CHOIR’s App Home in Slack.',
  'viewer.notice.deletedLast': 'Document deleted. This repository has no markdown documents left.',
  'viewer.notice.committed': 'Committed {sha} and refreshed the index.',
  'viewer.notice.saved': 'Saved.',
  'viewer.notice.dismiss.aria': 'Dismiss this notice',
  'viewer.notice.dismiss.title': 'Dismiss',
  'viewer.button.qaUsage': 'Q&A usage',
  'viewer.button.qaUsage.title': 'Highlight the sections used to answer questions',
  'viewer.button.history': 'History',
  'viewer.button.history.title': 'Change history',
  'viewer.button.doneEditing': 'Done editing',
  'viewer.button.editDocument': 'Edit document',
  'viewer.button.delete': 'Delete…',
  'viewer.button.discard': 'Discard',
  'viewer.button.save': 'Save…',
  'viewer.button.noChanges': 'No changes',
  'viewer.button.signOut': 'Sign out',
  'viewer.button.editAsManager': 'Edit as manager',
  'viewer.readOnly': 'Read-only',
  'viewer.changedBlocks': { one: '{count} changed block', other: '{count} changed blocks' },
  'viewer.aria.closeSidebar': 'Close sidebar',
  'viewer.marker.title': 'View change history',
  'viewer.usage.legend': 'Shaded sections were retrieved to answer questions (darker = more).',
  // "retrieval refer" is today's English, kept verbatim so this pass changes no
  // wording; the singular reads oddly and is worth a separate copy fix.
  'viewer.usage.unmatched': {
    one: '{count} retrieval refers to sections that have since changed.',
    other: '{count} retrievals refer to sections that have since changed.',
  },
  'viewer.usage.tooltip': {
    one: 'Retrieved in {count} question (last 12 weeks); {unanswered} unanswered',
    other: 'Retrieved in {count} questions (last 12 weeks); {unanswered} unanswered',
  },
  'viewer.commit.defaultMessage': 'Update {path}',

  // ── Commit dialog (CommitDialog.tsx) ────────────────────────────────────
  'commit.aria.dialog': 'Commit changes',
  'commit.title': 'Commit changes',
  'commit.subtitle':
    'A new commit will be pushed to your GitHub repository. Q&A retrieval and the QMD index refresh automatically.',
  'commit.label.message': 'Commit message',
  'commit.button.submitting': 'Committing…',
  'commit.button.submit': 'Commit & push',

  // ── Delete dialog (DeleteDocumentDialog.tsx) ────────────────────────────
  'delete.aria.dialog': 'Delete document',
  'delete.title': 'Delete this document',
  'delete.body':
    '{path} will be removed from the repository and will stop answering questions. If it has a Google Docs replica, that is unlinked and any pending review is dropped. Nothing is lost from git — the commit history keeps every version, so it can be restored from there.',
  'delete.body.onBranch':
    '{path} will be removed from the repository on {branch} and will stop answering questions. If it has a Google Docs replica, that is unlinked and any pending review is dropped. Nothing is lost from git — the commit history keeps every version, so it can be restored from there.',
  'delete.label.confirm': 'Type {path} to confirm',
  'delete.button.submitting': 'Deleting…',
  'delete.button.submit': 'Delete document',

  // ── New document dialog (NewDocumentDialog.tsx) ─────────────────────────
  'newDoc.aria.dialog': 'New document',
  'newDoc.title': 'New document',
  'newDoc.body.onBranch':
    'A document holding just its title is committed to {branch} and starts answering questions right away.',
  'newDoc.label.title': 'Title',
  'newDoc.label.path': 'Path in the repository',
  'newDoc.error.path': 'Give a repository-relative path ending in .md',
  'newDoc.button.submitting': 'Creating…',
  'newDoc.button.submit': 'Create document',

  // ── Change history (HistoryPanel.tsx) ───────────────────────────────────
  'history.type.update': 'Update',
  'history.type.append': 'Append',
  'history.type.newFile': 'New file',
  'history.type.webEdit': 'Manual edit',
  'history.type.gdocsEdit': 'Google Docs edit',
  'history.time.justNow': 'just now',
  'history.aria.panel': 'Change history',
  'history.title': 'Change history',
  'history.aria.close': 'Close',
  'history.search.placeholder': 'Search conversation, knowledge, changes',
  'history.aria.filterAuthor': 'Filter by author',
  'history.filter.allAuthors': 'All authors',
  'history.aria.filterDate': 'Filter by date',
  'history.filter.allTime': 'All time',
  'history.filter.last24h': 'Last 24 hours',
  'history.filter.last7d': 'Last 7 days',
  'history.filter.last30d': 'Last 30 days',
  'history.aria.sort': 'Sort',
  'history.sort.newest': 'Newest',
  'history.sort.size': 'Change size',
  'history.empty.membersOnly': 'Change history is visible to workspace members only.',
  'history.button.signIn': 'Sign in with Slack',
  'history.empty.authRequired': 'Only members of this workspace can view the change history.',
  'history.button.signInAgain': 'Sign in again',
  'history.empty.loadFailed': 'Failed to load history.',
  'history.empty.none': 'No change history yet.',
  'history.empty.noMatches': 'No history matches your filters.',
  'history.linesChanged': '{count} lines changed',
  'history.section.knowledge': 'Extracted knowledge',
  'history.section.conversation': 'Conversation',
  'history.section.changes': 'Changes',
  'history.aria.viewMode': 'Change view mode',
  'history.view.diff': 'Diff',
  'history.view.before': 'Before',
  'history.view.after': 'After',
  'history.diff.empty': 'No changes to show.',
  'history.diff.noPrevious': '(no previous content)',

  // ── Awareness dashboard (Dashboard.tsx, dashboard/charts.tsx) ───────────
  'dashboard.error.load': 'Could not load dashboard data.',
  'dashboard.aria.views': 'Views',
  'dashboard.tab.docs': 'Docs',
  'dashboard.tab.insights': 'Insights',
  'dashboard.signIn.prompt': 'Sign in to view team insights.',
  'dashboard.signIn.button': 'Sign in',
  'dashboard.membersOnly': 'Insights are available to registered CHOIR members.',
  'dashboard.title': 'Team insights',
  'dashboard.stat.questions': 'Questions asked',
  'dashboard.stat.answered': 'Answered from docs',
  'dashboard.stat.topics': 'Active topics',
  'dashboard.section.weekly': 'Questions per week',
  'dashboard.section.topics': 'Top topics',
  'dashboard.section.topics.sub': 'What the team asks about most. Answered from the docs vs. still unanswered.',
  'dashboard.section.gaps': 'Documentation gaps',
  'dashboard.section.gaps.sub': 'Frequently asked topics the documentation could not answer.',
  'dashboard.section.docUsage': 'Document usage',
  'dashboard.section.docUsage.sub': 'Which documents CHOIR draws on to answer questions.',
  'dashboard.footnote':
    'Aggregated by topic and week. No individual activity is shown. Topics asked by fewer than 2 people are grouped as “Other”.',
  'dashboard.topic.tooltip': {
    one: '{label}: {count} question, {answered} answered — “{representative}”',
    other: '{label}: {count} questions, {answered} answered — “{representative}”',
  },
  'dashboard.doc.tooltip': {
    one: '{label}: retrieved {count} time, {unanswered} when the answer fell short (last {week})',
    other: '{label}: retrieved {count} times, {unanswered} when the answer fell short (last {week})',
  },
  'dashboard.meter.aria': '{percent} answered',
  'dashboard.weekly.empty': 'No questions in this period yet.',
  'dashboard.weekly.aria': 'Questions per week',
  'dashboard.weekly.tooltip': {
    one: '{week}: {count} question, {answered} answered',
    other: '{week}: {count} questions, {answered} answered',
  },
  'dashboard.hbars.empty': 'Nothing to show yet.',
  'dashboard.legend.answered': 'answered',
  'dashboard.legend.unanswered': 'unanswered',
  'dashboard.hbars.tooltip': '{label}: {value}',
  'dashboard.gaps.empty': 'No documentation gaps surfaced in this period. 🎉',
  'dashboard.gaps.badge': '{count} unanswered',
  'dashboard.gaps.searched': 'Searched but insufficient:',

  // ── Google Docs sync (GoogleDocsSync.tsx) ───────────────────────────────
  'gdocs.sync.replaceWarning':
    'The content of the Google Doc you pick will be replaced by this document, and kept in sync from GitHub. Continue?',
  'gdocs.sync.error.link': 'Could not link the document',
  'gdocs.sync.error.picker': 'Could not start the file picker',
  'gdocs.sync.confirm.unlink': 'Stop syncing this document to Google Docs? The Google Doc itself is kept.',
  'gdocs.sync.error.unlink': 'Could not unlink the document',
  'gdocs.sync.button.fix': 'Fix Docs sync',
  'gdocs.sync.button.review': 'Review Docs edit',
  'gdocs.sync.title.awaitingManualApply':
    'This document keeps its own formatting, so a change from CHOIR is waiting for someone to apply it in Google Docs',
  'gdocs.sync.title.drifted': 'Someone edited the Google Doc; a manager is reviewing the change',
  'gdocs.sync.title.preserve': 'Open the Google Doc. CHOIR does not write to this one',
  'gdocs.sync.title.replica': 'Open the Google Docs replica',
  'gdocs.sync.link.label': 'Google Doc',
  'gdocs.sync.button.unlink': 'Unlink',
  'gdocs.sync.title.broken': 'The Google connection expired — reconnect to resume syncing',
  'gdocs.sync.title.connect': 'Publish this document as a Google Doc, kept in sync from GitHub',
  'gdocs.sync.button.busy': 'Working…',
  'gdocs.sync.button.reconnect': 'Reconnect Google',
  'gdocs.sync.button.sync': 'Sync to Google Docs',

  // ── Google Docs review (GoogleDocsReview.tsx) ───────────────────────────
  'gdocs.review.conflict.codeBlock':
    'This edit touches a code block. Google Docs has no code blocks, so the export cannot say whether the change was meant for the code or the text around it.',
  'gdocs.review.conflict.unmappable':
    'This text has no counterpart in the repository document, so there is no safe place to put it.',
  'gdocs.review.conflict.merge':
    'The repository and Google Docs both changed this. The repository version is kept below.',
  'gdocs.review.status.noChange': 'Nothing has changed in the Google Doc.',
  'gdocs.review.status.notLinked': 'This document is not linked to a Google Doc.',
  'gdocs.review.status.notConnected': 'The workspace Google account is not connected.',
  'gdocs.review.status.notDrifted': 'There is no pending Google Docs edit for this document.',
  'gdocs.review.status.baselineLost':
    'The comparison snapshot for this document is missing, so the edit cannot be worked out. Unlink and relink the document to start again.',
  'gdocs.review.error.load': 'Could not load the review',
  'gdocs.review.error.stale': 'Something changed while you were reviewing. The proposal below has been refreshed.',
  'gdocs.review.error.approve': 'Could not approve the change',
  'gdocs.review.error.reject': 'Could not reject the change',
  'gdocs.review.confirm.rebaseline':
    'Replace the Google Doc with the GitHub version? Anything written in the Doc will be lost.',
  'gdocs.review.error.republish': 'Could not republish',
  'gdocs.review.heading': 'Google Docs edit',
  'gdocs.review.baselineLost.help':
    'Republishing from GitHub rebuilds the comparison snapshot and gets syncing going again. {warning}, so copy out whatever is worth keeping first.',
  'gdocs.review.baselineLost.warning': 'Anything currently in the Google Doc will be replaced',
  'gdocs.review.button.republish': 'Republish from GitHub',
  'gdocs.review.button.openDoc': 'Open Doc',
  'gdocs.review.editedBy': 'Edited by {editor}.',
  'gdocs.review.editorUnknown': 'The editor could not be identified.',
  'gdocs.review.approveHint':
    'Approving commits this to GitHub and republishes the replica; rejecting discards it and restores the replica.',
  'gdocs.review.conflicts.count': {
    one: '{count} part could not be applied automatically',
    other: '{count} parts could not be applied automatically',
  },
  'gdocs.review.conflicts.hint': 'Edit the proposal below to include anything worth keeping.',
  'gdocs.review.newAssets': {
    one: '{count} new image will be committed alongside this change.',
    other: '{count} new images will be committed alongside this change.',
  },
  'gdocs.review.rejectedAssets': {
    one: '{count} image was dropped: {reasons}.',
    other: '{count} images were dropped: {reasons}.',
  },
  'gdocs.review.diff.identical': 'The proposal matches the repository exactly.',
  'gdocs.review.label.proposal': 'Proposed document',
  'gdocs.review.button.approve': 'Approve & commit',
  'gdocs.review.button.reject': 'Reject & restore replica',

  // ── Google Docs import (GoogleDocsImport.tsx) ───────────────────────────
  'gdocs.import.prompt': 'Import "{name}" into the repository as:',
  'gdocs.import.thisDocument': 'this document',
  'gdocs.import.error.path': 'Give a repository-relative path ending in .md',
  'gdocs.import.error.failed': 'Could not import that document',
  'gdocs.import.error.interrupted': 'The import stopped before it finished',
  'gdocs.import.rejectedAssets': {
    one: 'Imported, but {count} image was left out:\n{reasons}',
    other: 'Imported, but {count} images were left out:\n{reasons}',
  },
  'gdocs.import.button.importing': 'Importing…',
  'gdocs.import.button.import': 'Import from Google Docs',
  'gdocs.import.aria.progress': 'Google Docs import',
  'gdocs.import.starting': 'Starting the import…',

  // ── Import progress steps (services/google/import-steps.ts) ─────────────
  // Keyed by the `step` the NDJSON stream carries, not by the `label` beside
  // it: the label is the server's own English, for logs and for anyone reading
  // the stream by hand.
  'import.step.checking': 'Checking the repository',
  'import.step.reading': 'Reading the Google Doc',
  'import.step.committing': 'Committing to GitHub',
  'import.step.mirroring': 'Updating the local copy',
  'import.step.linking': 'Linking the Google Doc',
  'import.step.done': 'Done',

  // ── Google Picker (utils/picker.ts) ─────────────────────────────────────
  'picker.error.gapiMissing': 'Google API script loaded without gapi',
  'picker.error.scriptFailed': 'Could not load the Google file picker',
  'picker.error.start': 'Could not start the file picker',
  'picker.error.unavailable': 'The Google file picker is unavailable',

  // ── Asset upload (utils/assets.ts) ──────────────────────────────────────
  'assets.error.upload': 'Upload failed ({status})',
  'assets.error.missingPath': 'Upload response missing path',

  // ── Docs API error codes (i18n/server-errors.ts) ────────────────────────
  // One entry per `DocsApiErrorCode`. The English here is deliberately the
  // same text the server used to send, so an English reader sees no change;
  // `services/docs-editor/api-errors.ts` keeps the matching copy for logs.
  'serverError.internal_error': 'Internal server error',
  'serverError.unauthorized': 'Unauthorized',
  'serverError.forbidden': 'Forbidden',
  'serverError.not_signed_in': 'Not signed in',
  'serverError.workspace_mismatch': 'Session does not match workspace',
  'serverError.not_a_manager': 'User is not a workspace manager',
  'serverError.manager_access_required': 'Manager access required',
  'serverError.document_path_required': 'document path is required',
  'serverError.file_path_required': 'filePath is required',
  'serverError.content_required': 'content is required',
  'serverError.commit_message_required': 'commitMessage is required',
  'serverError.file_path_and_file_id_required': 'filePath and fileId are required',
  'serverError.file_path_and_content_required': 'filePath and content are required',
  'serverError.confirm_path_mismatch': 'The typed path does not match this document',
  'serverError.not_markdown_document': 'Only markdown documents can be deleted',
  'serverError.expected_image_body': 'Expected a binary image body',
  'serverError.invalid_language': 'Unsupported language',

  // ── Settings dialog ───────────────────────────────────────────────────────
  'settings.title': 'Settings',
  'settings.aria.dialog': 'Settings',
  'settings.aria.open': 'Settings',
  'settings.mine.label': 'Your language',
  'settings.mine.hint': 'The language CHOIR uses when it talks to you, here and in Slack.',
  'settings.workspace.label': 'Workspace language',
  'settings.workspace.hint': "Default for CHOIR's messages and buttons when a member has no preference.",
  'settings.content.label': 'Document content language',
  'settings.content.hint':
    "The language CHOIR writes new document content in. 'Follow the conversation' keeps today's behaviour.",
  'settings.option.auto': 'Automatic (follows your Slack language)',
  'settings.option.followConversation': 'Follow the conversation',
  'settings.button.save': 'Save',
  'settings.button.saving': 'Saving…',
  'settings.error.save': 'Could not save your settings. Please try again.',
  'serverError.invalid_document_path': 'Give a repository-relative path ending in .md',
  'serverError.document_exists': '{path} already exists in this repository',
  'serverError.document_not_found': 'File not found',
  'serverError.record_not_found': 'Record not found',
  'serverError.read_only_document': 'This document is marked read-only. Clear that in App Home before deleting it.',
  'serverError.write_access_denied': 'No write access to the workspace repository',
  'serverError.no_github_repo': 'No GitHub repository is connected to this workspace yet.',
  'serverError.github_no_token': 'Connect your GitHub account from the CHOIR App Home to edit {repo}.',
  'serverError.github_repo_is_archived': '{repo} is archived on GitHub, so it cannot be edited.',
  'serverError.github_repo_read_only':
    'Your GitHub account has read-only access to {repo}. Ask a repository admin for Write access, then reload this page.',
  'serverError.github_repo_not_visible':
    'Your GitHub account cannot see {repo}. Ask a repository admin to grant you access, then reload this page.',
  'serverError.github_credentials_rejected':
    'GitHub rejected the stored credentials while trying to {action} {target}. Reconnect your GitHub account from the CHOIR App Home and try again.',
  'serverError.github_rate_limited':
    'GitHub rate-limited the request to {action} {target}. Wait a moment and try again.',
  'serverError.github_oauth_app_restricted':
    "The {owner} organization has not approved CHOIR's GitHub OAuth app, so it cannot {action} {target}. An organization owner must approve it at {url}.",
  'serverError.github_sso_required':
    'Your GitHub authorization is not enabled for {owner}\'s SAML single sign-on, so CHOIR cannot {action} {target}. Authorize it under your GitHub account\'s "Authorized OAuth Apps" settings, then retry.',
  'serverError.github_repo_archived': '{repo} is archived or read-only, so CHOIR cannot {action} {target}.',
  'serverError.github_write_forbidden': 'GitHub refused to let the connected account {action} {target}.',
  'serverError.github_write_forbidden_detail':
    'GitHub refused to let the connected account {action} {target}. GitHub said: {detail}',
  'serverError.github_no_push_access':
    'GitHub answered 404 when CHOIR tried to {action} {target}. GitHub reports a missing write permission as 404, so the connected GitHub account almost certainly has no push access to {repo}. Ask a repository admin to grant Write access, or reconnect GitHub from the CHOIR App Home with an account that has it.',
  'serverError.github_target_not_found':
    'GitHub could not find {target}. Check the repository, branch, and file path configured for this workspace.',
  'serverError.github_branch_moved':
    'The branch moved while CHOIR was writing {target}, so the {action} was rejected as a conflict. Reload the document and re-apply your change.',
  'serverError.github_branch_protected':
    'GitHub rejected the {action} of {target}. A protected branch that requires a pull request is the usual cause.',
  'serverError.github_branch_protected_detail':
    'GitHub rejected the {action} of {target}. A protected branch that requires a pull request is the usual cause. GitHub said: {detail}',
  'serverError.github_unavailable':
    'GitHub is unavailable (HTTP {status}), so the {action} of {target} did not go through. Try again shortly.',
  'serverError.image_too_large': 'larger than 10MB',
  'serverError.too_many_images': 'too many new images in one edit',
  'serverError.unsupported_image_type': 'not a PNG, JPEG, GIF or WebP image',
  'serverError.google_not_connected': 'Connect a Google account first',
  'serverError.google_picker_not_configured':
    'The file picker is not configured (GOOGLE_PICKER_API_KEY, GOOGLE_PROJECT_NUMBER)',
  'serverError.google_no_access_token': 'Google did not return an access token',
  'serverError.google_pick_expired_link': 'Pick the document again — this link request has expired',
  'serverError.google_pick_expired_import': 'Pick the document again — this import request has expired',
  'serverError.google_doc_missing_in_repo': 'No such document in this workspace',
  'serverError.google_doc_trashed': 'That document is in the trash',
  'serverError.google_doc_already_linked': 'Google Doc {fileId} is already linked to {conflictPath}',
  'serverError.google_doc_not_linked': 'This document is not linked to a Google Doc',
  'serverError.github_document_gone': 'The GitHub document no longer exists. Unlink this replica instead.',
  'serverError.republish_failed': 'Could not republish this document from GitHub: {message}',
  'serverError.review_declined_not_restored': 'The document keeps the rejected text until someone reverts it',
  'serverError.import_invalid_path': 'Give a repository-relative path ending in .md',
  'serverError.import_path_exists': '{path} already exists in this repository',
  'serverError.import_empty': 'That document exported as empty',
  'serverError.import_failed': 'Could not import that document: {message}',
  'serverError.import_interrupted': 'The import stopped before it finished',

  // ── Milkdown/Crepe editor chrome (i18n/crepe.ts) ────────────────────────
  'editor.placeholder': 'Please enter...',
  'editor.slash.group.text': 'Text',
  'editor.slash.text': 'Text',
  'editor.slash.h1': 'Heading 1',
  'editor.slash.h2': 'Heading 2',
  'editor.slash.h3': 'Heading 3',
  'editor.slash.h4': 'Heading 4',
  'editor.slash.h5': 'Heading 5',
  'editor.slash.h6': 'Heading 6',
  'editor.slash.quote': 'Quote',
  'editor.slash.divider': 'Divider',
  'editor.slash.group.list': 'List',
  'editor.slash.bulletList': 'Bullet List',
  'editor.slash.orderedList': 'Ordered List',
  'editor.slash.taskList': 'Task List',
  'editor.slash.group.advanced': 'Advanced',
  'editor.slash.image': 'Image',
  'editor.slash.codeBlock': 'Code',
  'editor.slash.table': 'Table',
  'editor.slash.math': 'Math',
  'editor.image.uploadButton': 'Upload file',
  'editor.image.uploadButtonInline': 'Upload',
  'editor.image.confirmButton': 'Confirm',
  'editor.image.captionPlaceholder': 'Write Image Caption',
  'editor.image.uploadPlaceholder': 'or paste link',
  'editor.link.placeholder': 'Paste link...',
  'editor.code.searchPlaceholder': 'Search language',
  'editor.code.noResult': 'No result',
  'editor.code.copy': 'Copy',
  'editor.code.previewLabel': 'Preview',
  'editor.code.previewLoading': 'Loading...',
  'editor.code.previewEdit': 'Edit',
  'editor.code.previewHide': 'Hide',
} as const;
