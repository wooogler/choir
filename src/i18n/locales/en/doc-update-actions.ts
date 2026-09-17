/**
 * Strings for the two halves of the document-update *write* path: the modals a
 * manager opens off a suggestion (`docUpdate.actions.*` — create a file, create
 * a new section, get an edit link, look at the analyzed messages) and what
 * happens when one of them is submitted (`docUpdate.apply.*` — the commit
 * result, the channel announcement, cancelling or stopping the review).
 *
 * Keys: `docUpdate.<actions|apply>.<surface>.<element>[.<variant>]`. Three
 * conventions, shared with `notifications` and `doc-update-suggestions`. URLs
 * never enter the catalog: a `{...Link}` placeholder is filled with a
 * pre-formatted `<url|label>` whose label is its own key. A `.fallback` variant
 * is the plain-text twin of a block string, for Slack's notification preview.
 * And a name we could not resolve falls back to `docUpdate.user.fallbackName`,
 * which lives in `doc-update-suggestions` because all three surfaces share it.
 *
 * `docUpdate.apply.links` is the one shape worth explaining. The commit result
 * used to be assembled with `+=`, which left a translator with two half
 * sentences and no way to reorder them; it is now one sentence with a `{links}`
 * slot, filled either with a single link or with `docUpdate.apply.links.pair`.
 */

export const docUpdateActions = {
  // === Modals ==============================================================

  // --- "Get Edit Link", from inside the new-section modal ------------------
  'docUpdate.actions.editLink.selectFirst': '⚠️ Please select a file from the dropdown first.',
  'docUpdate.actions.editLink.title': 'Edit Link Sent',
  'docUpdate.actions.editLink.sent': 'The GitHub edit link has been sent to you via Direct Messages.',
  'docUpdate.actions.editLink.dm.fallback': '🔗 *GitHub Edit Link for {fileName}*',
  'docUpdate.actions.editLink.dm.body':
    '🔗 *GitHub Edit Link*\n\n📁 *File:* {fileName}\n🌐 *Link:* {editLink}\n\n💡 *Tip:* Click the link above to edit the file directly in GitHub.',
  'docUpdate.actions.editLink.label.open': 'Open in GitHub',
  'docUpdate.actions.editLink.error': '❌ Failed to generate edit link: {reason}',

  // --- "View analyzed messages" -------------------------------------------
  'docUpdate.actions.analyzed.title': 'Analyzed Messages',
  'docUpdate.actions.analyzed.summary':
    '📊 *Analysis Summary*\n• Session ID: `{sessionId}`\n• Total messages: {messageCount}',
  'docUpdate.actions.analyzed.listHeading': '*📝 Messages analyzed for knowledge extraction:*',
  'docUpdate.actions.analyzed.item': '*{number}. {username}*\n{text}{ellipsis}',
  'docUpdate.actions.analyzed.unknownUser': 'Unknown User',
  'docUpdate.actions.analyzed.noText': 'No text',
  'docUpdate.actions.analyzed.error': '❌ Failed to show analyzed messages: {reason}',

  // --- "Create New File": the button's receipt, the modal, its validation --
  'docUpdate.actions.createFile.selected': '📄 *Selected: Create New File*',
  'docUpdate.actions.createFile.selected.fallback': '📄 Selected: Create New File',
  'docUpdate.actions.createFile.title': 'Create New File',
  'docUpdate.actions.createFile.submit': 'Create File',
  'docUpdate.actions.createFile.intro':
    '📄 *Create a new markdown file in your repository*\n\nThis will create a new .md file in your GitHub repository and make it available for documentation updates.',
  'docUpdate.actions.createFile.name.label': 'File Name (must end with .md)',
  'docUpdate.actions.createFile.name.placeholder': 'e.g., new-documentation.md',
  'docUpdate.actions.createFile.content.label': 'Initial Content (Markdown)',
  // Both the hint and the prefilled body of a brand new file, so a manager who
  // types over it never sees a language switch between the two.
  'docUpdate.actions.createFile.content.placeholder': '# New Documentation\n\nAdd your initial content here...',
  'docUpdate.actions.createFile.expired':
    '⏳ This create-file form has expired. Please start again from the document update flow.',
  'docUpdate.actions.createFile.error.nameRequired': 'File name is required',
  'docUpdate.actions.createFile.error.contentRequired': 'File content is required',
  'docUpdate.actions.createFile.error.extension': 'File name must end with .md extension',
  'docUpdate.actions.createFile.error.invalidName':
    'File name contains invalid characters. Use only letters, numbers, dots, hyphens, and underscores.',
  'docUpdate.actions.createFile.creating':
    '📄 *Creating new file: {fileName}*\nPlease wait while I create the file in your GitHub repository...',
  'docUpdate.actions.createFile.creating.fallback': '📄 Creating new file...',
  'docUpdate.actions.createFile.failed.fallback': '❌ File creation failed',
  'docUpdate.actions.createFile.failed.exists':
    '❌ *File creation failed*\n\nA file named `{fileName}` already exists in the repository. Please choose a different file name.',
  'docUpdate.actions.createFile.failed.error':
    '❌ *File creation failed*\n\nSorry, I encountered an error while creating the file: {reason}',
  'docUpdate.actions.createFile.created':
    '✅ *File created successfully!*\n\n📄 {fileLink} has been created in your GitHub repository.',
  'docUpdate.actions.createFile.created.fallback': '✅ File created successfully!',
  'docUpdate.actions.createFile.initialContent': '*Initial Content:*\n```{content}```',
  'docUpdate.actions.createFile.done':
    '🎉 *Document update process complete!*\nYour new file has been created and is ready for use. You can mention me anytime with new knowledge to review and update docs!',
  'docUpdate.actions.createFile.channelNotice': '📄 New File Created by {createdBy}: {fileLink}',

  // --- "Create New Section": the modal --------------------------------------
  'docUpdate.actions.newSection.notEnoughInfo':
    'ℹ️ There isn’t enough information to draft a new section. Try sharing a bit more detail.',
  'docUpdate.actions.newSection.noWritableFiles':
    '❌ No writable files available for new sections. All files are marked as read-only.',
  'docUpdate.actions.newSection.title': 'Create a New Section',
  'docUpdate.actions.newSection.intro':
    "👋 I've prepared a new section for your documentation. Review and edit the content below, then click *Submit* to automatically add it to your selected file.\n\n",
  'docUpdate.actions.newSection.file.label': 'Select Target File',
  'docUpdate.actions.newSection.file.placeholder': 'Choose a file...',
  'docUpdate.actions.newSection.prepared': "*🎯 Here's the section I've prepared for you:*",
  'docUpdate.actions.newSection.sectionTitle.label': 'Section Title',
  'docUpdate.actions.newSection.sectionTitle.placeholder': 'Enter section title...',
  'docUpdate.actions.newSection.body.label': 'Section Content',
  'docUpdate.actions.newSection.body.placeholder': 'Enter section content...',
  'docUpdate.actions.newSection.manualEdit': '📝 *Alternatively, you can edit the selected file manually in GitHub:*',
  'docUpdate.actions.newSection.button.getEditLink': '🔗 Get Edit Link',
  'docUpdate.actions.newSection.error.open': '❌ Failed to open new section modal: {reason}',

  // === Applying =============================================================

  // --- The commit result, in the manager's DM ------------------------------
  'docUpdate.apply.error.noUpdates': 'No document updates found. Please try suggesting updates first.',
  'docUpdate.apply.applying': '⚙️ Applying changes to GitHub...',
  'docUpdate.apply.result.default': "I've finished processing the document updates!",
  'docUpdate.apply.result.success': "✅ Great news! I've successfully updated the document: {fileLink}",
  'docUpdate.apply.links': '\n\n📝 You can {links} directly on GitHub.',
  'docUpdate.apply.links.pair': '{viewLink} or {editLink}',
  'docUpdate.apply.link.viewChanges': 'view the changes',
  'docUpdate.apply.link.editFile': 'edit the file',
  'docUpdate.apply.result.partialFailure':
    '\nHowever, I ran into a little trouble updating *{fileName}*. You might want to check that one manually.',
  'docUpdate.apply.result.failure':
    "Hm, it looks like I couldn't update *{fileName}*. 😕 You might need to take a look and see what went wrong.",
  'docUpdate.apply.result.fallback':
    "Document update process completed! If there were any issues, I've noted them above.",
  'docUpdate.apply.error.github':
    '😥 Oops! It seems I ran into a problem while trying to update the document on GitHub. \nError: {reason}\n\nCould you please check the details or try again? If the problem persists, an administrator might need to look into it.',

  // --- The same commit, announced in the channel it came from --------------
  'docUpdate.apply.channel.updated':
    "🎉 Good news, everyone! *{userName}* just helped me update a document!\n\n*File:* {fileLink}\n*Section:* {sectionInfo}\n\nI've incorporated the latest insights. Teamwork makes the dream work! ✨",
  // Labels for the buttons the plain-text twin of that post describes.
  'docUpdate.apply.button.viewChanges': 'View Changes',
  'docUpdate.apply.button.viewFile': 'View File',

  // --- A submitted new section --------------------------------------------
  'docUpdate.apply.newSection.error.missingFields': '❌ Section title and body are required.',
  'docUpdate.apply.newSection.error.noTargetFile': '❌ No target file found. Please try again.',
  'docUpdate.apply.newSection.error.vectorStore': '❌ Failed to add new section to vector store for file: {fileName}',
  'docUpdate.apply.newSection.error.fileNotFound': '❌ Updated markdown file not found: {fileName}',
  'docUpdate.apply.newSection.error.invalidUrl': '❌ Invalid GitHub URL: {githubUrl}',
  'docUpdate.apply.newSection.error.submit': '❌ Failed to process new section submission: {reason}',
  'docUpdate.apply.newSection.success':
    '✅ New section "{sectionTitle}" added successfully to GitHub!\n\n📁 *File:* {fileLink}\n📝 *Added by:* {userName}',
  'docUpdate.apply.newSection.preview': '\n\n🔍 *Preview:*\n```# {sectionTitle}\n{sectionBody}```',
  'docUpdate.apply.newSection.channel':
    "🎉 Good news, everyone! *{userName}* just added a new section to our documentation!\n\n📁 *File:* {fileLink}\n📝 *Section:* {sectionTitle}\n\nI've added the new content. Knowledge grows stronger! ✨",
  'docUpdate.apply.newSection.channel.preview': '🔍 *Preview of new section:*\n```# {sectionTitle}\n{sectionBody}```',
  'docUpdate.apply.newSection.channel.fallback':
    '✅ New Section Added: {sectionTitle} in {fileName} by *{userName}* (with CHOIR)',

  // --- Cancelling or stopping the review -----------------------------------
  'docUpdate.apply.cancel.cancelled': '👋 Review cancelled',
  'docUpdate.apply.cancel.stopped': {
    one: "✅ Review stopped! We've applied {count} suggestion to the documentation.",
    other: "✅ Review stopped! We've applied {count} suggestions to the documentation.",
  },
  'docUpdate.apply.cancel.notice.cancelled': 'cancelled their document update review',
  'docUpdate.apply.cancel.notice.stopped': {
    one: 'stopped their document update review after applying {count} suggestion',
    other: 'stopped their document update review after applying {count} suggestions',
  },
  'docUpdate.apply.cancel.channel': '📋 *{userName}* {notice}.',
  'docUpdate.apply.cancel.error.fallback': '❌ Failed to cancel document updates: {reason}',
  'docUpdate.apply.cancel.error': '❌ *Error occurred while cancelling*\n{reason}',
} as const;
