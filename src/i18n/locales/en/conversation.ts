/**
 * Strings for the conversation feature. Keys: `conversation.<surface>.<element>[.<variant>]`.
 *
 * Three surfaces live here. The general-chat reply: CHOIR's own "here is how to
 * use me" guide (the LLM-written answer next to it is generated, never
 * translated) and the documentation footnote. The "I may have misunderstood
 * you" prompt and what happens after either of its buttons is clicked. And the
 * handful of user-facing strings owned by the event handlers that feed this
 * feature — the router's fallback error, the anonymous-thread relay, and the
 * offer to restart a review after a modal was cancelled — which have no feature
 * catalog of their own because they are the conversation entry point.
 *
 * URLs never enter the catalog: `{documentationLink}` and `{channelLink}` are
 * filled with a pre-formatted `<url|label>` whose label is itself a key.
 */

export const conversation = {
  // The static self-description, sent instead of an LLM answer when someone
  // asks what CHOIR is or how to use it.
  'conversation.usageGuide.body':
    'Hi *{userName}*! 👋 I\'m CHOIR, and I\'m here to help you with {organizationName}\'s documents and knowledge management.\n\n*🔍 Here\'s how you can use me:*\n\n*💬 For Questions:* Ask me anything about your documents or {organizationName}\n• Example: "What\'s our policy on remote work?"\n• Example: "How do we handle code reviews?"\n\n*📝 For Updates:* Share new information that should be documented\n• Example: "We decided to use React for the new project"\n• Example: "Our deployment process now includes automated testing"\n\n*🔧 How to reach me:*\n• *In channels:* Mention me with `@choir` followed by your message\n• *Direct message:* Send me a DM. You can add me by clicking my profile picture.\n\n*✨ I can also help you update documents, extract knowledge from conversations, and keep your team\'s information organized.*\n\nWhat would you like to try first?',

  // Appended to a general answer when the workspace has a repository.
  'conversation.reply.source': '_Based on {documentationLink}_',
  'conversation.link.documentation': "{organizationName}'s documentation",

  // The private nudge under a general answer, offering to re-run the message
  // as a question or as a document update request.
  'conversation.clarifyPrompt.body': '💡 *If I misunderstood your message, please click one of the buttons below:*',
  'conversation.clarifyPrompt.fallback': '💡 If I misunderstood your message, please click one of the buttons below:',
  'conversation.clarifyPrompt.question.button': '❓ This was a question',
  'conversation.clarifyPrompt.updateRequest.button': '📝 This was an update request',

  // After "This was a question": a public note in the channel the message came
  // from, the prompt rewritten in place, and the failure path.
  'conversation.reclassify.question.announcement':
    "🤔 *{userName}* let me know this was actually a question - I'll handle it properly now!",
  'conversation.reclassify.question.processed':
    '✅ *Message processed as Question*\n\n📝 *Original message:* "{originalMessage}"\n🔄 *Action taken:* Searching documents and generating answer',
  'conversation.reclassify.question.processed.fallback': '✅ Processed as Question',
  'conversation.reclassify.question.error': '❌ Failed to process your message as a question: {reason}',

  // The same three, for "This was an update request".
  'conversation.reclassify.updateRequest.announcement':
    "📝 *{userName}* clarified this was a suggestion for updating our docs - I'll work on that now!",
  'conversation.reclassify.updateRequest.processed':
    '✅ *Message processed as Update Request*\n\n📝 *Original message:* "{originalMessage}"\n🔄 *Action taken:* Extracting knowledge and generating document updates',
  'conversation.reclassify.updateRequest.processed.fallback': '✅ Processed as Update Request',
  'conversation.reclassify.updateRequest.error': '❌ Failed to process your message as an update request: {reason}',

  // Event-handler surfaces.
  'conversation.error.generic': 'Sorry, an error occurred. Please try again.',
  'conversation.anonymousThread.reply': '💬 *{authorName}* replied to your anonymous question:\n\n{message}',
  'conversation.restartRecovery.fallback': 'Canceled — want to start over?',
  // One whole sentence per cancelled modal rather than a `{what}` slot: the
  // noun phrase inflects differently in every language that has cases.
  'conversation.restartRecovery.newFile':
    '↩️ You canceled creating a new file. Want to pick the review back up from the top?',
  'conversation.restartRecovery.newSection':
    '↩️ You canceled creating a new section. Want to pick the review back up from the top?',
} as const;
