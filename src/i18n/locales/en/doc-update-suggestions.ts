/**
 * Strings for the document-update *review* surface: the suggestion card a
 * manager steps through in their DM, the flows around it (initial search, file
 * switch, skip, keep, completion, the review screen for a channel suggestion,
 * the concurrency notice) and the suggestion editor modal.
 *
 * Keys: `docUpdate.suggestions.<surface>.<element>[.<variant>]`, plus two
 * groups that are deliberately not surface-scoped because they are shared with
 * the sibling doc-update catalogs: `docUpdate.user.*` (name fallbacks) and
 * `docUpdate.channel.*` (what `getChannelName` says when it has no name).
 *
 * Three conventions carry over from `notifications`. URLs never enter the
 * catalog — a `{...Link}` placeholder is filled with a pre-formatted
 * `<url|label>` whose label is its own key — a `.fallback` variant is the
 * plain-text twin used for Slack's notification preview, and a message that is
 * *also* sent by the manager-notification fan-out reuses the
 * `notifications.manager.suggestion.*` key rather than restating it here.
 *
 * One string carries a hidden contract: every `docUpdate.suggestions.bonus.*`
 * value must keep its leading `💡`. `message-cleanup.ts` strips stale hint
 * blocks by testing `text.startsWith('💡')`, so a translation that drops the
 * emoji would leave the hint behind on an answered card.
 */

export const docUpdateSuggestions = {
  // --- Shared across the doc-update surfaces -------------------------------
  // The name a message falls back to when Slack will not tell us who acted.
  'docUpdate.user.fallbackName': 'User',
  // `getChannelName` has no name to show: a DM has none, and an unreadable
  // channel is still "this channel" to the person reading the sentence.
  'docUpdate.channel.dm': 'DM',
  'docUpdate.channel.this': 'this channel',

  // --- The suggestion card -------------------------------------------------
  'docUpdate.suggestions.card.heading': '📝 *Update Suggestion {number}*',
  'docUpdate.suggestions.card.anchor.range': '\nAnchor: lines {startLine}-{endLine}',
  'docUpdate.suggestions.card.anchor.single': '\nAnchor: line {startLine}',
  'docUpdate.suggestions.card.fileInfo': 'File: {fileLink}\nSection: {sectionInfo}{anchor}',
  'docUpdate.suggestions.card.explain.changes':
    "📝 I found content that could be *updated* based on your knowledge. I'm showing you the specific changes I'd recommend - you can see exactly what would be modified or added.",
  'docUpdate.suggestions.card.explain.aligned':
    "✅ Great news! This section is already well-aligned with your knowledge. I'm showing you the current content so you can verify it covers what you intended.",
  'docUpdate.suggestions.card.fallback': 'Document Update Suggestions',

  // --- Buttons on the card and in the flows around it ----------------------
  'docUpdate.suggestions.button.edit': 'Edit This',
  'docUpdate.suggestions.button.apply': '✅ Apply Changes',
  'docUpdate.suggestions.button.looksGood': '✅ Looks Good',
  'docUpdate.suggestions.button.skip': '⏭️ Skip This',
  'docUpdate.suggestions.button.stop': 'Stop Review',
  'docUpdate.suggestions.button.newSection': '💡 Create New Section',
  'docUpdate.suggestions.button.newFile': '📄 Create New File',
  'docUpdate.suggestions.button.startOver': '🔄 Start Over',
  'docUpdate.suggestions.button.editSuggestion': '✏️ Edit Suggestion',
  'docUpdate.suggestions.button.startProcess': '🚀 Start Update Process',
  // The same action as `button.newSection`, offered when the repository had no
  // matching content at all; it has always worn a different emoji.
  'docUpdate.suggestions.button.createSection': '📝 Create New Section',

  // --- Inline file switcher ------------------------------------------------
  'docUpdate.suggestions.fileSwitcher.prompt': '📁 *Updating this file* — pick another to switch:',
  'docUpdate.suggestions.fileSwitcher.placeholder': 'Choose a file...',

  // --- The "other options" hint under the card -----------------------------
  'docUpdate.suggestions.link.here': 'here',
  'docUpdate.suggestions.bonus.newSectionOrEdit':
    '💡 *Other options:* You can create a new section instead of updating this one, or edit {fileName} directly in GitHub {editLink}.',
  'docUpdate.suggestions.bonus.newSectionOnly':
    '💡 *But here\'s a thought:* Even though this section is already well-aligned, your knowledge might deserve its own dedicated section! I can suggest where and how to create a new section for your content. Check out the "Create New Section" option below!',
  'docUpdate.suggestions.bonus.editOnly':
    '💡 *Alternative option:* You can edit {fileName} document in GitHub directly {editLink}.',

  // --- Progress and failure while a suggestion is being produced -----------
  'docUpdate.suggestions.loading.searchingAll': '🔍 Finding relevant documents across all files...',
  'docUpdate.suggestions.loading.forFile': '📝 Generating suggestions for {fileName}...',
  'docUpdate.suggestions.loading.generating': '📝 Generating update suggestions...',
  'docUpdate.suggestions.error.noKnowledge': 'No knowledge content found. Please try again.',
  'docUpdate.suggestions.error.processingDocument': '❌ Error processing document. Skipping to next.',
  'docUpdate.suggestions.error.generic': 'An error occurred while suggesting document updates: {reason}',
  'docUpdate.suggestions.error.missingUpdate':
    '❌ Error: Could not retrieve the details for this update. Please try again or skip.',
  'docUpdate.suggestions.error.noContentInFile':
    'No relevant content found in the selected file: {fileName}. Please try selecting a different file or choose "All Files" option.',
  'docUpdate.suggestions.error.noDocuments':
    '📝 No documents found in your repository. Please connect a GitHub repository with markdown files first, or add some markdown files to your repository.',
  'docUpdate.suggestions.error.noRelevantDocuments':
    'No relevant documents found for the extracted knowledge. Please try with different knowledge or contact an administrator.',

  // --- The project folder had nothing, so the search was widened ----------
  // One line, in the manager's DM, before the first candidate from outside the
  // project folder arrives (docs/project-folders.md 4).
  'docUpdate.suggestions.scope.widened': '_Nothing in `{folder}` matched, so I searched the whole repository._',

  // --- Nothing in the index matched, so we offer a brand new section -------
  'docUpdate.suggestions.empty.fallback':
    "💡 Since you don't have any existing content in your vector store, I'll help you create a new section for this knowledge!",
  'docUpdate.suggestions.empty.body':
    "💡 *No existing content found - Let's create something new!*\n\nI've prepared a new section for your knowledge. Click below to review and add it to your documentation.",

  // --- A skipped suggestion, confirmed in place of the card ----------------
  'docUpdate.suggestions.skip.confirmed': '⏭️ *Skipped* suggestion {number} for {fileName}',
  'docUpdate.suggestions.skip.confirmed.fallback': '⏭️ Skipped suggestion {number} for {fileName}',
  'docUpdate.suggestions.skip.unknownFile': 'Unknown file',

  // --- The end of the review ----------------------------------------------
  'docUpdate.suggestions.complete.prompt':
    "🎉 *Review Complete!* We've gone through all relevant documents. \n\nWould you like to create new content instead?",
  'docUpdate.suggestions.complete.fallback': '🎉 Review Complete! Create new content?',
  'docUpdate.suggestions.complete.hint': 'Or mention me anytime with new knowledge to review and update docs! 👋',
  // The fallback when the "create something new" options could not be built.
  'docUpdate.suggestions.complete.simple':
    "🎉 Perfect! We've reviewed all the relevant documents. Thanks for working with me to keep your documentation up-to-date! \n\nIf you have more knowledge to share later, just mention me and I'll be happy to help review and update the docs again. Have a great day! 👋",

  // --- An applied suggestion, announced back in the source channel ---------
  'docUpdate.suggestions.applied.channel': '✅ Document Updated by {updatedBy}: {fileLink} - {sectionInfo}',
  'docUpdate.suggestions.applied.updatedContent': '*Updated Content:*\n```{content}```',

  // --- The review screen for a suggestion that came from a channel ---------
  'docUpdate.suggestions.review.intro.own':
    "Hi! I'm CHOIR, your documentation assistant.\n\nYou have a document update suggestion:",
  'docUpdate.suggestions.review.intro.other':
    "Hi! I'm CHOIR, your documentation assistant.\n\n*{userName}* has a document update suggestion:",
  'docUpdate.suggestions.review.prompt.own': 'Please review your suggestion above and choose how to proceed:',
  'docUpdate.suggestions.review.prompt.other':
    'You requested this document update suggestion. Please review the content above and choose how to proceed:',
  'docUpdate.suggestions.review.fallback': '📝 Document update suggestion from *{userName}*',

  // --- Another manager got there first ------------------------------------
  'docUpdate.suggestions.conflict.anotherManager': 'Another manager',
  'docUpdate.suggestions.conflict.claimed': '❌ *Already being processed by {managerName}*',
  'docUpdate.suggestions.conflict.claimed.fallback': '❌ Already being processed by {managerName}',
  'docUpdate.suggestions.image.alt.profile': 'User profile',

  // --- The suggestion editor modal ----------------------------------------
  'docUpdate.suggestions.editor.title': 'Edit Update Suggestion',
  'docUpdate.suggestions.editor.submit': 'Save Changes',
  'docUpdate.suggestions.editor.originalLabel': '*Original Content:*',
  'docUpdate.suggestions.editor.updatedLabel': 'Updated Content',
  'docUpdate.suggestions.editor.emptySection': '*Empty section - content will be generated*',
  'docUpdate.suggestions.editor.fallback': 'Document Update Suggestion',
  'docUpdate.suggestions.editor.error.open': 'Cannot open update editor: {reason}',
  'docUpdate.suggestions.editor.error.save': 'Cannot save changes: {reason}',
  // Appended by `buildSectionBlocks` when a section is too large to preview in
  // full; `{characters}` is already grouped for the reader's locale.
  'docUpdate.suggestions.preview.truncated': '_… preview truncated ({characters} more characters not shown)_',
} as const;
