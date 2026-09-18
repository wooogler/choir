// Strings for the app-home feature. Keys: `appHome.<surface>.<element>[.<variant>]`,
// with the manager-only modals (which are their own views, not home sections)
// grouped under `appHome.management.<surface>.*`.
//
// The home view itself is four tabs (see `docs/app-home.md`), so a row's *own*
// copy — its bold label and one-line status — is named after the tab it sits on:
// `appHome.home.*`, `appHome.documents.*`, `appHome.team.*`, `appHome.advanced.*`,
// with the tab bar under `appHome.tabs.*`. Button labels and confirm dialogs keep
// their older action-shaped keys (`appHome.documentConnection.reload.*`,
// `appHome.contextKey.rotate.button`, …) because they describe the *action*, which
// is the same wherever it is rendered; moving them would be a rename for its own
// sake and would throw away their Korean.
//
// The language settings were the first App Home section to go through the
// catalog: they are the one place a person can be reading CHOIR in a language
// they cannot yet change, so the picker itself has to speak their language.
// Option labels are shared by all three selects — the value each one carries
// differs (`auto`/`follow-conversation` vs a locale), the wording does not.
//
// `.title` is reserved for real modal titles, where the catalog test's 24-char
// cap is exactly the constraint we want enforced; the redesign left no Slack
// `header` blocks in the home view at all.
export const appHome = {
  // --- The tab bar ----------------------------------------------------------
  'appHome.tabs.home': '🏠 Home',
  'appHome.tabs.documents': '📁 Documents',
  'appHome.tabs.team': '👥 Team',
  'appHome.tabs.advanced': '⚙️ Advanced',

  'appHome.language.mine.label': '*Your language*\nThe language CHOIR uses when it talks to you.',
  'appHome.language.mine.placeholder': 'Select a language',

  'appHome.language.workspace.label': '*Workspace language*',
  'appHome.language.workspace.context': "Default for CHOIR's messages and buttons when a member has no preference",
  'appHome.language.workspace.placeholder': 'Select a language',

  'appHome.language.content.label': '*Document content language*',
  'appHome.language.content.context':
    "Language CHOIR writes new document content in; 'Follow the conversation' keeps today's behaviour",
  'appHome.language.content.placeholder': 'Select a language',

  'appHome.language.option.auto': 'Automatic (follows your Slack language)',
  'appHome.language.option.english': 'English',
  'appHome.language.option.korean': '한국어',
  'appHome.language.option.followConversation': 'Follow the conversation',

  'appHome.language.confirm.mine': '✅ Language set to {language}.',
  'appHome.language.confirm.mineAuto': '✅ Language set to automatic — CHOIR will use {language}.',
  'appHome.language.confirm.workspace': '✅ Workspace language set to {language}.',
  'appHome.language.confirm.content': '✅ Document content language set to {language}.',

  // --- Home: the welcome row every visitor sees -----------------------------
  'appHome.welcome.greeting': '*Welcome, {user}* :wave:',
  'appHome.welcome.intro':
    "CHOIR answers questions from your team's docs and turns Slack conversations into document updates.",
  'appHome.welcome.startChat.button': '💬 Start Chatting with CHOIR',
  'appHome.docs.open.button': '📖 Open Docs',
  'appHome.insights.open.button': '📊 Open Team Insights',

  // --- Home: the manager's setup card ---------------------------------------
  // Configured lines collapse into one summary section; anything unfinished
  // becomes its own row carrying the control that fixes it.
  'appHome.home.setup.label': '*Setup*',
  'appHome.home.setup.github.done': '✅ GitHub account · {login}',
  'appHome.home.setup.github.todo': '*GitHub account*\n❌ Not connected · connect it to pick a repository',
  'appHome.home.setup.repo.done': '✅ Repository · {repo}',
  'appHome.home.setup.repo.todo': '*Repository*\n❌ None · choose the repository CHOIR reads',
  'appHome.home.setup.channel.done': '✅ Q&A channel · #{channel}',
  'appHome.home.setup.channel.todo': '*Q&A channel*\n❌ Not set · "Ask to Channel" stays off until you pick one',
  'appHome.home.setup.people.done': '✅ {users} CHOIR users · {managers} managers',

  // --- Advanced: AI models --------------------------------------------------
  'appHome.advanced.openai.summary': '*AI models*\nKey: {keyStatus} · Q&A: {qaModel} · Updates: {documentUpdateModel}',
  'appHome.advanced.openai.context': 'Classification model: {classificationModel} (fixed)',
  'appHome.openai.key.workspaceSet': '✅ Workspace key set ({masked})',
  'appHome.openai.key.serverDefault': '🟡 Using server default key',
  'appHome.openai.key.notConfigured': '❌ Not configured',
  'appHome.openai.model.serverDefault': 'Server default',
  'appHome.openai.configure.button': 'Configure OpenAI',
  'appHome.openai.clear.button': 'Clear Settings',
  'appHome.openai.clear.confirm.title': 'Clear OpenAI Settings?',
  'appHome.openai.clear.confirm.text':
    'CHOIR will fall back to the server default key. The workspace-specific key and model choices will be removed.',
  'appHome.openai.clear.confirm.ok.button': 'Clear',

  // --- Advanced: change-history encryption key ------------------------------
  'appHome.advanced.contextKey.configured': '*Change history encryption*\n✅ Key configured{details}',
  'appHome.advanced.contextKey.notGenerated':
    '*Change history encryption*\n🟡 Not yet generated · created on the first recorded change',
  'appHome.contextKey.status.created': 'created {date}',
  'appHome.contextKey.status.rotated': 'rotated {date}',
  'appHome.contextKey.backup.button': 'Back Up Key',
  'appHome.contextKey.rotate.button': 'Rotate Key',
  'appHome.contextKey.import.button': 'Import Key',
  'appHome.contextKey.warning':
    '⚠️ Rotating or importing a new key makes *all previously recorded change history permanently unreadable*. Back up the current key first if you may need the old history.',

  // --- Team: managers, CHOIR users, Q&A channel, organization ---------------
  'appHome.team.managers.summary': '*Managers* ({count})\n{list}',
  'appHome.team.managers.none': '*Managers*\nNobody has manager rights yet.',
  'appHome.team.choirUsers.summary': '*CHOIR users*\n{count} registered',
  'appHome.team.qaChannel.configured': '*Q&A channel*\n✅ #{channel}',
  'appHome.team.qaChannel.notConfigured': '*Q&A channel*\n❌ Not set · "Ask to Channel" is disabled until you pick one',
  'appHome.team.qaChannel.notFound': '*Q&A channel*\n⚠️ The saved channel is gone · pick another one',
  'appHome.team.organization.summary': '*Organization*\n{name}',
  'appHome.choirManagement.managers.button': 'Manage Managers',
  'appHome.choirManagement.choirUsers.button': 'Manage CHOIR Users',
  'appHome.choirManagement.qaChannel.placeholder': 'Select Channel',

  // --- Home: the non-manager's route to manager rights ----------------------
  'appHome.becomeManager.hint': '🔒 _Need access to advanced features? Contact your workspace administrator._',
  'appHome.becomeManager.button': 'Manager Access',

  // --- Documents: GitHub connection, repository, files, index maintenance ---
  'appHome.documents.github.connected': '*GitHub account*\n✅ {login} · connected {date}',
  'appHome.documents.github.notConnected': '*GitHub account*\n❌ Not connected · connect it to pick a repository',
  'appHome.documents.repo.connected': '*Repository*\n✅ {repoLink}',
  'appHome.documents.repo.notConnected': '*Repository*\n❌ None · choose the repository CHOIR reads',
  'appHome.documents.repo.change.button': 'Change',
  'appHome.documents.readOnly.summary': '*Read-only files*\n{count} of {total} files are excluded from updates',
  'appHome.documents.readOnly.current': 'Currently excluded: {list}',
  'appHome.documents.readOnly.currentNone': 'Nothing is excluded right now.',
  'appHome.documents.readOnly.more': 'and {count} more',
  'appHome.documents.readOnly.needsRepo': '*Read-only files*\n🟡 Connect a repository first',
  'appHome.documents.readOnly.loading': '*Read-only files*\n🟡 Loading files from GitHub…',
  'appHome.documentConnection.disconnect.button': 'Disconnect GitHub',
  'appHome.documentConnection.disconnect.confirm.title': 'Disconnect GitHub',
  'appHome.documentConnection.disconnect.confirm.text':
    'Are you sure you want to disconnect your personal GitHub account?',
  'appHome.documentConnection.disconnect.confirm.ok.button': 'Disconnect',
  'appHome.documentConnection.connect.button': 'Connect GitHub Account',
  'appHome.documentConnection.repo.label': '{owner}/{repo}',
  'appHome.documentConnection.repo.labelWithPath': '{owner}/{repo} (Path: {path})',
  'appHome.documentConnection.browse.button': 'Browse My Repositories',
  'appHome.documentConnection.indexManagement.summary':
    '*Index maintenance*\nRun after editing markdown files or when answers look stale.',
  'appHome.documentConnection.normalize.button': 'Normalize Markdown',
  'appHome.documentConnection.normalize.confirm.title': 'Normalize Markdown Files',
  'appHome.documentConnection.normalize.confirm.text':
    'This will convert all markdown files to tree format and back to markdown, standardizing the formatting. This may change newlines, list styles, etc.',
  'appHome.documentConnection.normalize.confirm.ok.button': 'Normalize',
  'appHome.documentConnection.reload.button': 'Reload from GitHub',
  'appHome.documentConnection.reload.confirm.title': 'Reload from GitHub?',
  'appHome.documentConnection.reload.confirm.text':
    'This will fetch the latest files from GitHub and update the vector store. Any unsaved changes will be overwritten.',
  'appHome.documentConnection.reload.confirm.ok.button': 'Reload',
  'appHome.documentConnection.rebuildQmd.button': 'Rebuild QMD Index',
  'appHome.documentConnection.rebuildQmd.confirm.title': 'Rebuild QMD Index?',
  'appHome.documentConnection.rebuildQmd.confirm.text':
    'This will delete the local QMD SQLite index and rebuild it from the synced markdown mirror. Use this after chunking changes or if retrieval looks stale.',
  'appHome.documentConnection.rebuildQmd.confirm.ok.button': 'Rebuild',

  // --- Team + modal: the organization's display name ------------------------
  'appHome.organization.defaultName': 'Our Organization',
  'appHome.organization.edit.button': 'Edit Organization Name',
  'appHome.organization.edit.title': 'Edit Organization Name',
  'appHome.organization.edit.submit': 'Save Changes',
  'appHome.organization.edit.label': 'Organization Name',
  'appHome.organization.edit.placeholder': 'Enter your organization name (e.g., Smith Research Lab, AI Team, etc.)',
  'appHome.organization.edit.success': '✅ Organization name updated to "{name}"!',
  'appHome.organization.edit.error.open': '❌ Error opening edit modal. Please try again.',
  'appHome.organization.edit.error.required': 'Organization name is required.',
  'appHome.organization.edit.error.save': 'An error occurred while updating organization name. Please try again.',

  // --- Advanced + DM: interaction log downloads -----------------------------
  'appHome.advanced.logs.summary': '*Download logs*\nInteraction logs for analysis and research.',
  'appHome.logs.today.button': "Today's Logs",
  'appHome.logs.today.preparing': "📊 Preparing today's interaction logs for download...",
  'appHome.logs.today.fileTitle': "Today's Interaction Logs",
  'appHome.logs.today.comment': "📊 Here are today's interaction logs ({date}) for analysis.",
  'appHome.logs.today.uploaded': "✅ Successfully uploaded today's interaction logs ({size}KB)",
  'appHome.logs.all.button': 'All Logs',
  'appHome.logs.all.preparing': '📊 Preparing all interaction logs for download...',
  'appHome.logs.all.fileTitle': 'All Interaction Logs',
  'appHome.logs.all.comment': '📊 Here are all your interaction logs for analysis.',
  'appHome.logs.all.uploaded': '✅ Successfully uploaded all interaction logs ({size}KB)',
  'appHome.logs.error.none': '❌ No interaction logs found.',
  'appHome.logs.error.noneToday': '❌ No interaction log files found for today ({date}).',
  'appHome.logs.error.noneAll': '❌ No interaction log files found.',
  'appHome.logs.error.upload': '❌ Error uploading log files. Please try again.',
  'appHome.logs.error.prepare': '❌ Error preparing interaction logs. Please try again.',

  // --- Advanced: the file-logging switch ------------------------------------
  'appHome.advanced.logging.enabled': '*Interaction logging*\n✅ On · interactions are saved to log files for research',
  'appHome.advanced.logging.disabled': '*Interaction logging*\n❌ Off · nothing is written to the log files',
  'appHome.logging.enable.button': 'Enable Logging',
  'appHome.logging.disable.button': 'Disable Logging',

  // --- Documents: files excluded from document updates ----------------------
  'appHome.readOnly.manage.button': 'Manage Read-Only Files',

  // --- Management: the denial every gated App Home action shares -------------
  'appHome.management.error.permissionDenied': "❌ You don't have permission to perform this action.",

  // --- Management: the manager roster modal ---------------------------------
  'appHome.management.managers.title': 'Manage Managers',
  'appHome.management.managers.submit': 'Update Managers',
  'appHome.management.managers.intro':
    '👑 *Select Managers*\n\nChoose which workspace members should have manager permissions. Managers can access advanced features and grant permissions to other users.',
  'appHome.management.managers.status': {
    one: '📊 *Current Status:* {count} manager assigned',
    other: '📊 *Current Status:* {count} managers assigned',
  },
  'appHome.management.managers.label': 'Managers',
  'appHome.management.managers.placeholder': 'Select users to be managers...',
  'appHome.management.managers.hint':
    'Selected users will have manager permissions and access to all CHOIR management features.',
  'appHome.management.managers.warning':
    '⚠️ *Important:* Removing manager permissions may affect their ability to manage CHOIR settings.',
  'appHome.management.managers.result.added': '✅ Added manager permission for {user}',
  'appHome.management.managers.result.addFailed': '❌ Failed to add manager permission for {user}',
  'appHome.management.managers.result.addError': '❌ Error adding manager permission for {user}',
  'appHome.management.managers.result.removed': '✅ Removed manager permission from {user}',
  'appHome.management.managers.result.removeFailed': '❌ Failed to remove manager permission from {user}',
  'appHome.management.managers.result.removeError': '❌ Error removing manager permission from {user}',
  'appHome.management.managers.updated': {
    one: '✅ Manager permissions updated successfully! {count} manager is now assigned.{changes}',
    other: '✅ Manager permissions updated successfully! {count} managers are now assigned.{changes}',
  },
  'appHome.management.managers.noChanges': '✅ No changes made to manager permissions.',
  'appHome.management.managers.error.open': '❌ Error opening manager management modal. Please try again.',
  'appHome.management.managers.error.empty': 'Please select at least one manager or cancel to keep current settings.',
  'appHome.management.managers.error.permission': "❌ You don't have permission to manage managers.",
  'appHome.management.managers.error.partial': 'Some manager permission changes failed. Please try again.',
  'appHome.management.managers.error.generic': 'An error occurred while updating managers. Please try again.',

  // --- Management: the CHOIR-user roster modal ------------------------------
  'appHome.management.choirUsers.title': 'Manage CHOIR Users',
  'appHome.management.choirUsers.submit': 'Update Users',
  'appHome.management.choirUsers.intro':
    '👥 *Select CHOIR Users*\n\nChoose which workspace members can use CHOIR features and participate in the research study. Managers are automatically included.',
  'appHome.management.choirUsers.status': {
    one: '📊 *Current Status:* {count} user registered',
    other: '📊 *Current Status:* {count} users registered',
  },
  'appHome.management.choirUsers.label': 'CHOIR Users',
  'appHome.management.choirUsers.placeholder': 'Select users to include in CHOIR...',
  'appHome.management.choirUsers.hint':
    'Selected users will be able to use CHOIR features. Managers are automatically included.',
  'appHome.management.choirUsers.privacy':
    "🔒 *Privacy Note:* Only selected users' messages will be included in CHOIR's conversation history and research data.",
  'appHome.management.choirUsers.updated': {
    one: '✅ CHOIR users updated successfully! {count} user is now registered. Please refresh your app home to see the changes.',
    other:
      '✅ CHOIR users updated successfully! {count} users are now registered. Please refresh your app home to see the changes.',
  },
  'appHome.management.choirUsers.error.open': '❌ Error opening user management modal. Please try again.',
  'appHome.management.choirUsers.error.empty': 'Please select at least one user or cancel to keep current settings.',
  'appHome.management.choirUsers.error.save': '❌ Failed to update CHOIR users. Please try again.',
  'appHome.management.choirUsers.error.generic': 'An error occurred while updating users. Please try again.',
  'appHome.management.choirUsers.error.postAck': '❌ An error occurred while updating CHOIR users. Please try again.',

  // --- Management: the read-only file picker modal --------------------------
  'appHome.management.readOnly.title': 'Manage Read-Only Files',
  'appHome.management.readOnly.submit': 'Update Files',
  'appHome.management.readOnly.intro':
    '🔒 *Select Read-Only Files*\n\nRead-only files are excluded from document updates but remain searchable. Choose which files should be protected from automatic updates.',
  'appHome.management.readOnly.status': '📊 *Current Status:* {count} of {total} files are read-only',
  'appHome.management.readOnly.label': 'Select files to mark as read-only',
  'appHome.management.readOnly.placeholder': 'Search files to mark as read-only...',
  'appHome.management.readOnly.tip':
    "💡 *Tip:* Read-only files can still be searched and referenced, but they won't be modified during document updates.",
  'appHome.management.readOnly.updated': {
    one: '✅ Read-only files updated successfully! {count} file is now marked as read-only. Please refresh your app home to see the changes.',
    other:
      '✅ Read-only files updated successfully! {count} files are now marked as read-only. Please refresh your app home to see the changes.',
  },
  'appHome.management.readOnly.error.noFiles':
    '❌ No markdown files found. Please connect to a GitHub repository first.',
  'appHome.management.readOnly.error.open': '❌ Error opening read-only files management modal. Please try again.',
  'appHome.management.readOnly.error.save': 'Failed to update read-only files. Please try again.',
  'appHome.management.readOnly.error.generic': 'An error occurred while updating read-only files. Please try again.',

  // --- Management: password-based self-promotion ----------------------------
  'appHome.management.promotion.title': 'Become Manager',
  'appHome.management.promotion.intro':
    '🔐 *Manager Promotion*\n\nEnter the manager promotion password to gain manager permissions.',
  'appHome.management.promotion.label': 'Password',
  'appHome.management.promotion.placeholder': 'Enter promotion password...',
  'appHome.management.promotion.success':
    '✅ Congratulations! You have been promoted to manager. Please refresh your app home to see the changes.',
  'appHome.management.promotion.error.open': '❌ Error opening manager promotion modal. Please try again.',
  'appHome.management.promotion.error.empty': 'Please enter the promotion password.',
  'appHome.management.promotion.error.invalid': 'Invalid password. Please check the password and try again.',
  'appHome.management.promotion.error.generic': 'An error occurred while processing your request. Please try again.',

  // --- Management: the Q&A channel select -----------------------------------
  'appHome.management.qaChannel.success': '✅ Q&A channel has been set to #{channel}.',
  'appHome.management.qaChannel.error.permission': "❌ You don't have permission to change the Q&A channel.",
  'appHome.management.qaChannel.error.access':
    '❌ Cannot access the selected channel. Please invite CHOIR to it or pick a public channel.',
  'appHome.management.qaChannel.error.generic': '❌ Failed to set Q&A channel. Please try again.',

  // --- Management: the file-logging switch ----------------------------------
  'appHome.management.logging.enabled': '✅ Logging has been enabled. Please refresh your app home to see the changes.',
  'appHome.management.logging.disabled':
    '❌ Logging has been disabled. Please refresh your app home to see the changes.',
  'appHome.management.logging.error': '❌ Error toggling logging setting. Please try again.',

  // --- Management: the OpenAI key and model modal ---------------------------
  'appHome.management.openai.title': 'OpenAI Settings',
  'appHome.management.openai.submit': 'Save',
  'appHome.management.openai.intro':
    '🔐 *OpenAI API Key & Models*\nManage the key CHOIR uses for this workspace and pick which GPT-5 models power Q&A and document updates. Classification always uses a fixed model.',
  'appHome.management.openai.apiKey.label': 'API Key',
  'appHome.management.openai.apiKey.placeholder': 'sk-...',
  'appHome.management.openai.apiKey.hint.existing': 'Current key: {masked}. Leave blank to keep it.',
  'appHome.management.openai.apiKey.hint.new': 'Paste your OpenAI API key. It will be validated before saving.',
  'appHome.management.openai.model.placeholder': 'Use default',
  'appHome.management.openai.qaModel.label': 'Q&A Model',
  'appHome.management.openai.documentUpdateModel.label': 'Document Update Model',
  'appHome.management.openai.saved': '✅ OpenAI settings saved.',
  'appHome.management.openai.cleared':
    '✅ Workspace OpenAI settings cleared. CHOIR will fall back to the server default key.',
  'appHome.management.openai.error.permission': "❌ You don't have permission to configure OpenAI settings.",
  'appHome.management.openai.error.open': '❌ Error opening OpenAI settings. Please try again.',
  'appHome.management.openai.error.validation': 'Key validation failed: {reason}',
  'appHome.management.openai.error.unknownReason': 'unknown error',
  'appHome.management.openai.error.save': 'An error occurred while saving. Please try again.',
  'appHome.management.openai.error.postAck':
    '⚠️ Your OpenAI settings may not have been fully saved. Please reopen the settings and try again.',

  // --- Management: rotating, backing up and importing the provenance key -----
  'appHome.management.contextKey.confirm.label': 'Type {phrase} to confirm',
  'appHome.management.contextKey.confirm.error': 'Type {phrase} exactly to confirm.',
  'appHome.management.contextKey.rotate.title': 'Rotate Key',
  'appHome.management.contextKey.rotate.submit': 'Rotate',
  'appHome.management.contextKey.rotate.warning':
    '⚠️ *This permanently destroys access to all existing change history.*\n\nEvery previously recorded update (its conversation, extracted knowledge, and diff) was encrypted with the current key. A new key cannot decrypt them — those records become unreadable forever. Back up the current key first if you might need the old history.',
  'appHome.management.contextKey.rotate.success':
    '🔐 Provenance key rotated. New change history will use the new key; records made with the previous key are no longer readable.',
  'appHome.management.contextKey.rotate.error.modal': 'Failed to rotate the key. Please try again.',
  'appHome.management.contextKey.rotate.error.postAck': '❌ Failed to rotate the provenance key. Please try again.',
  'appHome.management.contextKey.backup.title': 'Back Up Key',
  'appHome.management.contextKey.backup.close': 'Done',
  'appHome.management.contextKey.backup.intro':
    '*Provenance key (base64).* Store this somewhere safe and private — anyone with it can decrypt this workspace’s change history. You will need it to read existing history after a key rotation or a database restore.',
  'appHome.management.contextKey.backup.missing':
    'No provenance key exists yet — it is generated on the first recorded document change.',
  'appHome.management.contextKey.import.title': 'Import Key',
  'appHome.management.contextKey.import.submit': 'Import',
  'appHome.management.contextKey.import.warning.configured':
    '⚠️ Importing a key *replaces the current one*. Existing change history encrypted with the current key becomes unreadable unless you re-import that key later. Back it up first if unsure.',
  'appHome.management.contextKey.import.warning.new':
    'Set this workspace’s provenance key from a base64-encoded 32-byte key (e.g. a backup from another environment).',
  'appHome.management.contextKey.import.key.label': 'Base64 key (32 bytes)',
  'appHome.management.contextKey.import.key.placeholder': 'Paste the base64 key',
  'appHome.management.contextKey.import.success':
    '🔐 Provenance key imported. Change history recorded from now on uses it, and history encrypted with this key (e.g. a restored backup) is readable again.',
  'appHome.management.contextKey.import.error.invalidKey': 'Enter a base64-encoded 32-byte key.',
  'appHome.management.contextKey.import.error.modal': 'Failed to import the key. Please try again.',
  'appHome.management.contextKey.import.error.postAck': '❌ Failed to import the provenance key. Please try again.',
} as const;
