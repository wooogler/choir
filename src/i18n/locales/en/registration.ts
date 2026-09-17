/**
 * Strings for the registration feature. Keys: `registration.<surface>.<element>[.<variant>]`.
 *
 * The whole self-service access flow, which crosses between two readers more
 * often than any other surface in CHOIR: the person asking for access reads the
 * `nonUser.*` notice and the `request.*` / `decline.notice` / `approve.welcome`
 * replies, while the `managerCard.*` strings are read by every manager the
 * request fans out to. Each call site binds its own reader's translator; the
 * card is built once per manager for exactly that reason.
 *
 * URLs never enter the catalog: `{consentFormLink}` and `{channelLink}` are
 * filled with a pre-formatted `<url|label>` / `<#channel>` by the caller, and
 * the link's label is itself a `registration.link.*` key.
 */

export const registration = {
  'registration.managerCard.request': '🙋 *{userName}* is requesting access to CHOIR.',
  // The plain-text twin of the card, for Slack's notification preview.
  'registration.managerCard.request.fallback': '{userName} is requesting access to CHOIR.',
  // The two mutually exclusive halves of the card's context line, joined by a
  // space with the consent reminder below — one key per sentence, so a
  // translator is never asked to reassemble a sentence from fragments.
  'registration.managerCard.origin.channel': 'Asked in {channelLink}.',
  'registration.managerCard.origin.dm': 'Asked in a direct message.',
  'registration.managerCard.consentReminder': "Reminder: check they've completed the {consentFormLink}.",
  'registration.link.consentForm': 'consent form',
  'registration.managerCard.approve.button': '✅ Approve',
  'registration.managerCard.decline.button': 'Decline',
  // The card rewritten in place once a manager decides, with the buttons gone.
  // Broadcast to every manager at once, so it follows the workspace language.
  'registration.managerCard.approved': '✅ *{targetName}* — approved by *{managerName}*.',
  'registration.managerCard.declined': '🚫 *{targetName}* — declined by *{managerName}*.',

  // The requester's own message, replaced in place after they tap the button.
  'registration.request.alreadyPending': '⏳ Your request is already waiting for manager approval.',
  'registration.request.expired': 'Please ask me a question again to request access.',
  'registration.request.noManagers':
    '⚠️ No managers are configured in this workspace yet. Please contact your Slack admin.',
  'registration.request.managersUnreachable':
    "⚠️ I couldn't reach any manager right now — please try asking again in a moment.",
  'registration.request.sent': "✅ Request sent to {managers}. If approved, I'll answer your question right away.",

  // Both decisions race on one row, so either button can land second.
  'registration.action.alreadyHandled': 'ℹ️ This request was already handled.',
  'registration.action.claimedByOther': 'ℹ️ Another manager just handled this request.',

  // Approval: the deciding manager's confirmation, then the requester's DM.
  'registration.approve.confirmation': '✅ *{targetName}* is now a CHOIR user.',
  'registration.approve.welcome':
    "🎉 You're in! You can now ask me anything about the team's documentation. Just send me a question anytime.",
  'registration.approve.welcome.withQuestion':
    "🎉 You're in! You can now ask me anything about the team's documentation.\n\nHere's the answer to the question you asked earlier:",
  'registration.approve.originChannelHint':
    'You originally asked this in {channelLink} — feel free to share the answer there.',

  // Decline: the deciding manager's confirmation, then the requester's DM.
  'registration.decline.confirmation': "🚫 Declined *{targetName}*'s access request.",
  'registration.decline.notice':
    "Your CHOIR access request wasn't approved this time. If you think this is a mistake, please reach out to a workspace manager directly.",

  // What a stranger sees when they first message CHOIR, by where they are in
  // the flow. Read by that person, who may have no cached locale yet.
  'registration.nonUser.fresh':
    "Hi! 👋 I'm CHOIR, your team's documentation assistant. You're not a CHOIR user yet — tap the button below and a workspace manager can approve you with one click.",
  'registration.nonUser.fresh.privacy':
    "If approved, I'll answer the question you just asked right away. Until then it stays private — I don't process or store it.",
  'registration.nonUser.fresh.consent': 'Your manager may ask you to complete the consent form: {consentFormLink}.',
  'registration.link.consentFormHere': 'here',
  'registration.nonUser.pending':
    "⏳ Your access request is waiting for manager approval. I'll message you as soon as you're in!",
  'registration.nonUser.declined':
    "Your earlier access request wasn't approved. If you think this is a mistake, please reach out to a workspace manager directly.",
  'registration.nonUser.request.button': '🙋 Request Access',
} as const;
