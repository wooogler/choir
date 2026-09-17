/**
 * Strings for the knowledge-extraction half of document updates. Keys:
 * `docUpdate.extract.<surface>.<element>[.<variant>]`.
 *
 * The flow crosses three audiences and the surfaces are named after them. The
 * requester sees `progress`/`preview` in the channel and `actions` in their own
 * ephemeral; a manager sees `card` in their DM, plus `managerEdit`; both edit
 * through `edit.modal`. `reviewCancel` is the separate "cancel the review"
 * path, which speaks about a suggestion in the third person because whoever
 * reads it may be neither the author nor the reviewer.
 *
 * Two conventions from the shared catalogs apply here too. A `.fallback`
 * variant is the plain-text twin of a block string, used for Slack's
 * notification preview. And link URLs never enter the catalog: a `{...Link}`
 * placeholder takes a pre-formatted `<url|label>` whose label is itself a
 * `notifications.link.*` key — this feature reuses
 * `notifications.manager.suggestion.context` for exactly that.
 */

export const docUpdateExtract = {
  // Who the suggestion is addressed to, when no manager name is available or
  // when one name has to stand in for several.
  'docUpdate.extract.managers.fallback': 'managers',
  'docUpdate.extract.managers.andOthers': '{name} and other managers',

  // The bot's own message in the channel the request came from: first a
  // placeholder while the model runs, then the extracted knowledge in its place.
  'docUpdate.extract.progress.analyzing': '🔍 Analyzing recent messages to extract knowledge...',
  'docUpdate.extract.preview.intro': "Sure! I'll suggest the following update to {managerText}.",
  'docUpdate.extract.preview.heading': 'Suggested Update',
  'docUpdate.extract.preview.edited': "Sure! I'll suggest the following update to {managerText}. *(Edited)*",
  'docUpdate.extract.preview.edited.fallback': "Sure! I'll suggest the following update to {managerText}. (Edited)",
  'docUpdate.extract.preview.editedByManager':
    "Sure! I'll suggest the following update to {managerText}. *(Edited by Manager)*",
  'docUpdate.extract.preview.editedByManager.fallback':
    "Sure! I'll suggest the following update to {managerText}. (Edited by Manager)",
  'docUpdate.extract.empty': 'I couldn’t find documentable knowledge in the recent conversation.',
  'docUpdate.extract.empty.detail':
    'I couldn’t find documentable knowledge in the recent conversation.\n\nPlease include the specific policy, deadline, file, or process that should change, then try again.',

  // The requester's own ephemeral under that message: the only place the
  // suggestion can still be edited or withdrawn before managers see it.
  'docUpdate.extract.actions.editHint': 'You can edit the suggested update if needed.',
  'docUpdate.extract.actions.edit.button': 'Edit',
  'docUpdate.extract.actions.confirmHint': "When you're ready, click Suggest Update to confirm.",
  'docUpdate.extract.actions.suggest.button': 'Suggest Update',

  // The edit modal, opened by the requester before the suggestion is sent.
  'docUpdate.extract.edit.modal.title': 'Edit Knowledge',
  'docUpdate.extract.edit.modal.submit': 'Update Knowledge',
  'docUpdate.extract.edit.modal.intro': '*Edit the extracted knowledge before applying updates:* ',
  'docUpdate.extract.edit.modal.label': 'Knowledge Content',
  'docUpdate.extract.edit.modal.placeholder': 'Enter the knowledge to be documented...',
  'docUpdate.extract.edit.modal.source': {
    one: '📊 *Source:* {count} message analyzed',
    other: '📊 *Source:* {count} messages analyzed',
  },

  // The same modal reopened by a manager, on knowledge someone else wrote.
  // English is 24 characters here, exactly Slack's cap for a modal title.
  'docUpdate.extract.managerEdit.modal.title': 'Edit Submitted Knowledge',
  'docUpdate.extract.managerEdit.modal.intro': '*Edit the knowledge submitted by the user:*',

  // The suggestion card in a manager's DM. It is written once per manager, then
  // rewritten in place as the suggestion is edited, claimed or dismissed, so
  // every variant below has to read as the same card.
  'docUpdate.extract.card.header': '📝 Document Update Suggestion',
  'docUpdate.extract.card.header.editedByManager': '📝 Document Update Suggestion (Edited by Manager)',
  'docUpdate.extract.card.fallback': 'Document Update Suggestion',
  'docUpdate.extract.card.new.fallback': '📝 New document update suggestion from *{userName}* for your review.',
  'docUpdate.extract.card.updatedByManager.fallback':
    '📝 Document update suggestion updated by manager for session {sessionId}.',
  'docUpdate.extract.card.intro':
    "Hi! I'm CHOIR, your documentation assistant.\n \n \n*{userName}* has a document update suggestion:",
  'docUpdate.extract.card.unknownUser': 'Unknown User',
  // Alt text on the requester's avatar, when their name is not known.
  'docUpdate.extract.card.profileAlt': 'User profile',
  'docUpdate.extract.card.from': '*From:* {user} (Original requester: {userName})',
  'docUpdate.extract.card.fromWithContent':
    '*From:* {user} (Original requester: {userName})\n*Content:*\n```{content}```',
  'docUpdate.extract.card.fromName': '*From:* *{userName}*',
  'docUpdate.extract.card.claimed':
    '✅ *Processing started by {managerName}*\n~~This suggestion is now being processed.~~',
  'docUpdate.extract.card.editKnowledge.button': 'Edit Knowledge',
  'docUpdate.extract.card.editSuggestion.button': '✏️ Edit Suggestion',
  'docUpdate.extract.card.startUpdate.button': 'Start Document Update',
  'docUpdate.extract.card.startProcess.button': '🚀 Start Update Process',
  'docUpdate.extract.card.dismiss.button': 'Dismiss',
  'docUpdate.extract.card.decline.button': 'Decline',
  // Reposted to the manager when the card it should have replaced is gone.
  'docUpdate.extract.card.knowledgeUpdated': '*Knowledge Updated (Original Message Not Found):*\n```{content}```',
  'docUpdate.extract.card.knowledgeUpdated.fallback':
    'Knowledge updated. You can now start the document update process.',

  // Handing the suggestion over to the managers.
  'docUpdate.extract.sent.ephemeral':
    '✅ *Update suggestion sent!*\nYour suggestion has been forwarded to the managers for review.',
  'docUpdate.extract.sent.ephemeral.fallback': '✅ Update suggestion sent!',
  'docUpdate.extract.sent.channel': {
    one: "✅ Great news, *{userName}*! Your document update suggestion has been successfully sent to our manager: {managerNames}. They'll review it soon!",
    other:
      "✅ Great news, *{userName}*! Your document update suggestion has been successfully sent to our managers: {managerNames}. They'll review it soon!",
  },
  'docUpdate.extract.sent.channel.fallback': {
    one: "✅ Great news, *{userName}*! Your document update suggestion has been successfully sent to our manager: {managerNames}. They'll review it soon! (Sent from channel: #{channelName})",
    other:
      "✅ Great news, *{userName}*! Your document update suggestion has been successfully sent to our managers: {managerNames}. They'll review it soon! (Sent from channel: #{channelName})",
  },
  'docUpdate.extract.sent.dm': {
    one: '✅ Your update suggestion has been passed to {count} manager for review. They will be able to apply the suggestion to update documents or provide feedback.',
    other:
      '✅ Your update suggestion has been passed to {count} managers for review. They will be able to apply the suggestion to update documents or provide feedback.',
  },

  // A manager claiming the suggestion, and the manager who was a moment late.
  'docUpdate.extract.conflict.anotherManager': 'Another manager',
  'docUpdate.extract.conflict.body':
    '❌ *Already being processed*\n\n{managerName} is currently handling this suggestion. Please wait for them to complete the process.',
  'docUpdate.extract.conflict.fallback': '❌ Already being processed by {managerName}',
  'docUpdate.extract.processing.body':
    '✅ *Processing started!*\n🔄 Generating document suggestions...\nDocument suggestions will be sent to your DM.',
  'docUpdate.extract.processing.fallback': '✅ Processing started!',
  'docUpdate.extract.processing.openDm.button': 'Open DM',
  'docUpdate.extract.processing.channel': '🔄 Manager is processing the knowledge and generating document updates...',
  'docUpdate.extract.processing.channel.fallback': '🔄 Processing knowledge and generating document updates...',

  // The requester withdrawing their own suggestion.
  'docUpdate.extract.cancel.ephemeral': '✅ *Processing your decision...*',
  'docUpdate.extract.cancel.ephemeral.fallback': '✅ Got it!',
  'docUpdate.extract.cancel.channel': '❌ The update suggestion has been *cancelled*.',
  'docUpdate.extract.cancel.channel.fallback': '❌ Update suggestion cancelled',

  // A manager declining it instead.
  'docUpdate.extract.decline.unknownManager': 'manager',
  'docUpdate.extract.decline.anonymousManager': 'A manager',
  'docUpdate.extract.decline.declinedBy': '❌ *Declined by {managerName}* - No further action will be taken.',
  'docUpdate.extract.decline.channel':
    '❌ *{userName}*, your document update suggestion was *declined by {managerName}*. No changes will be made to the documentation at this time.',
  'docUpdate.extract.decline.channel.fallback': '❌ Update suggestion declined by {managerName}',
  'docUpdate.extract.decline.otherManagers':
    '{decliningManagerName} declined the document update suggestion from *{userName}*. You can still review this suggestion if you think it has merit.',

  // Cancelling a review that is already under way: the suggestion is referred
  // to by its short id because the three audiences see three different cards.
  'docUpdate.extract.reviewCancel.anonymousSuggester': 'the original suggester',
  'docUpdate.extract.reviewCancel.anonymousUser': 'User',
  'docUpdate.extract.reviewCancel.anonymousUserShort': 'the user',
  'docUpdate.extract.reviewCancel.by.self': '*You* (the suggester)',
  'docUpdate.extract.reviewCancel.by.other': '*{userName}*',
  'docUpdate.extract.reviewCancel.by.reviewer':
    '*{userName}* (reviewer). The original suggestion was from *{suggesterName}*.',
  'docUpdate.extract.reviewCancel.channel':
    '🙅‍♀️ Okay, the document update suggestion (ID: {sessionId}) has been cancelled by {cancelledBy}. No further action will be taken on this one for now. If you change your mind, you can always start a new suggestion!',
  'docUpdate.extract.reviewCancel.channel.fallback': 'Update suggestion review (ID: {sessionId}) has been cancelled.',
  'docUpdate.extract.reviewCancel.manager.byUser':
    '🙅‍♀️ The document update suggestion (ID: {sessionId}) was cancelled by *{userName}*. No further action is needed from your side for this one. Thanks!',
  'docUpdate.extract.reviewCancel.manager.byReviewer':
    '🙅‍♀️ The document update suggestion (ID: {sessionId}), originally from *{suggesterName}*, was cancelled by another reviewer (*{userName}*). No further action is needed from your side for this one. Thanks!',
  'docUpdate.extract.reviewCancel.manager.bySuggester':
    '🙅‍♀️ The document update suggestion (ID: {sessionId}) from *{suggesterName}* was cancelled by them. No further action is needed from your side for this one. Thanks!',
  'docUpdate.extract.reviewCancel.manager.fallback': 'Suggestion review cancelled.',
  'docUpdate.extract.reviewCancel.own.default':
    "Got it! I've cancelled this update suggestion (ID: {sessionId}). Feel free to start a new one anytime!",
  'docUpdate.extract.reviewCancel.own.manager':
    "Okay, I've marked the suggestion (ID: {sessionId}) from *{suggesterName}* as cancelled. No further action from you is needed on this.",
  'docUpdate.extract.reviewCancel.own.suggester':
    "Okay, *{userName}*, I've cancelled your update suggestion (ID: {sessionId}). If you want to suggest something else, just let me know.",
  'docUpdate.extract.reviewCancel.own.other':
    'The update suggestion (ID: {sessionId}) has been cancelled by *{userName}*.',
  'docUpdate.extract.reviewCancel.own.fallback': 'Update suggestion cancelled.',

  // Failures. `{reason}` is the caught error's own message, which stays in
  // whatever language the thrower used — a locale is not worth losing a cause.
  'docUpdate.extract.error.unknown': 'Unknown error',
  'docUpdate.extract.error.noMessages': '❌ No messages found to analyze.',
  'docUpdate.extract.error.invalidSession': '❌ Invalid session. Please try the knowledge extraction again.',
  'docUpdate.extract.error.invalidSessionSubmit': '❌ Invalid session. Please try submitting your suggestion again.',
  'docUpdate.extract.error.sessionMissing': '❌ Session data not found. Please try the knowledge extraction again.',
  'docUpdate.extract.error.sessionMissingSubmit':
    '❌ Session data not found. Please try submitting your suggestion again.',
  'docUpdate.extract.error.sessionMissingManager':
    '❌ Session data not found. Please try again or ask the user to resubmit.',
  'docUpdate.extract.error.emptyContent': '❌ Please provide some knowledge content before proceeding.',
  'docUpdate.extract.error.noManagers': '❌ No managers found in this workspace. Please contact an administrator.',
  'docUpdate.extract.error.extractionFailed': '❌ Failed to extract knowledge from messages: {reason}',
  'docUpdate.extract.error.extractionFailed.fallback': '❌ Failed to extract knowledge from messages.',
  'docUpdate.extract.error.modalOpenFailed': '❌ Failed to open edit modal. Please try again.',
  'docUpdate.extract.error.managerModalOpenFailed': '❌ Failed to open knowledge edit modal: {reason}',
  'docUpdate.extract.error.editFailed': '❌ Error processing knowledge edit: {reason}',
  'docUpdate.extract.error.sendFailed': '❌ Failed to send your suggestion to managers. Please try again later.',
  'docUpdate.extract.error.applyFailed': '❌ Failed to apply knowledge: {reason}',
  'docUpdate.extract.error.dmLinkFailed': '❌ Could not create a link to DM. Please try again or contact support.',
  'docUpdate.extract.error.cancelFailed': '❌ *Error occurred while cancelling*\n{reason}',
  'docUpdate.extract.error.cancelFailed.fallback': '❌ Failed to cancel: {reason}',
  'docUpdate.extract.error.reviewCancelNoSession':
    "Sorry, I couldn't process the cancellation because the session ID was missing. Please try again or contact support if this continues.",
  'docUpdate.extract.error.reviewCancelFailed':
    "😥 Oops! I couldn't cancel the suggestion review right now. Error: {reason}. Please try again!",
} as const;
