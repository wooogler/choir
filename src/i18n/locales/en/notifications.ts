/**
 * Strings for the notifications feature. Keys: `notifications.<surface>.<element>[.<variant>]`.
 *
 * Every string here is *recipient-scoped*: it is sent to someone who is not the
 * person who acted (a manager receiving a review card, a webhook fan-out with no
 * actor at all), so the call site binds the recipient's translator rather than
 * the request's.
 *
 * Two conventions shape the shapes below. Link URLs never enter the catalog —
 * a `{...Link}` placeholder is filled with a pre-formatted `<url|label>` whose
 * label is itself a `notifications.link.*` key — and a `.fallback` variant is
 * the plain-text twin of a block string, used for Slack's notification preview
 * where mrkdwn and links would only render as noise.
 */

export const notifications = {
  // Link labels. The URL is the caller's; only the words are translated.
  'notifications.link.viewRepository': 'View Repository',
  'notifications.link.viewDiscussion': 'View original discussion',

  // GitHub webhook auto-reload, fanned out to every manager (no actor).
  'notifications.webhook.started': '🔄 Reflecting your document changes...',
  'notifications.webhook.noDocuments': '❌ Unable to reflect changes: No documents found.',
  'notifications.webhook.noDocuments.detail': '❌ Unable to reflect changes: No documents found. {repositoryLink}',
  'notifications.webhook.succeeded': {
    one: '✅ Document changes reflected successfully! Updated {count} file. {link}',
    other: '✅ Document changes reflected successfully! Updated {count} files. {link}',
  },
  'notifications.webhook.processingFailed': '❌ Unable to reflect changes: Processing failed.',
  'notifications.webhook.processingFailed.detail':
    '❌ Unable to reflect changes: Processing failed. Try "Reload From Github" in Home or contact research team. {repositoryLink}',
  'notifications.webhook.systemError': '❌ Unable to reflect document changes: System error occurred.',
  'notifications.webhook.systemError.detail':
    '❌ Unable to reflect document changes: System error occurred. Try "Reload From Github" in Home or contact research team. {repositoryLink}',

  // A manager being told another manager already touched the document.
  'notifications.manager.update.fallback': '📝 Document Update by {updatedBy}',
  'notifications.manager.update.body':
    '📝 *Document Update Notification*\n\n{updatedBy} has updated a document that you were also reviewing.',

  // The suggestion card in a manager's DM, rewritten in place once claimed.
  'notifications.manager.suggestion.intro':
    "Hi! I'm CHOIR, your documentation assistant.\n*{userName}* has a document update suggestion:",
  'notifications.manager.suggestion.anonymousUser': 'A team member',
  'notifications.manager.suggestion.noContent': 'No content available',
  'notifications.manager.suggestion.context': '📍 {discussionLink} for context',
  'notifications.manager.suggestion.claimed': '✅ *Processing started by {managerName}*',
  'notifications.manager.suggestion.claimed.fallback': '✅ Processing started by {managerName}',

  // Posted back to the channel the suggestion came from, so it follows the
  // workspace language rather than any one reader's.
  'notifications.channel.processingStarted':
    "🔄 *{managerName}* started processing your document update suggestion. You'll receive the document suggestions in your DM shortly! 📝",
  'notifications.channel.processingStarted.fallback':
    '🔄 {managerName} started processing your document update suggestion.',

  // Shown when Slack throttles us mid-request; `{context}` names what was asked.
  'notifications.rateLimit.notice':
    "⏳ I'm experiencing high traffic and need to slow down a bit. Your {context} request is being processed but may take a moment longer than usual. Thank you for your patience!",
} as const;
