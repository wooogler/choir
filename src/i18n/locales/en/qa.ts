// Strings for the qa feature. Keys: `qa.<surface>.<element>[.<variant>]`.
//
// have their own catalog file: `locales/en/index.ts` is what decides which
// files make up the catalog, and it is not ours to edit. Splitting them out is
// a one-line change to that index the day it is allowed.
//
// Two conventions show up a lot below. A message that Slack shows twice (the
// `text` fallback in the notification and the block that renders in the
// conversation) is two keys, the fallback suffixed `.text`, because the
// fallback is plain while the block carries mrkdwn. And the question and the
// answer themselves are never in here: they are the model's and the user's
// words, interpolated as `{question}` / `{response}`, and only the sentences
// around them are ours to translate.
export const qa = {
  // --- Shared errors, posted ephemerally when a share cannot start ---------
  'qa.error.missingSession': '😅 Oops! Something went wrong. Could you try asking your question again?',
  'qa.error.noConversationDetails': "😅 I can't find the conversation details. Mind asking your question again?",
  'qa.error.noChannel': '❌ No Q&A channel is configured. Please ask an admin to set up a Q&A channel.',
  'qa.error.openShareModal': '😔 Something went wrong opening the sharing options. Could you try again?',
  'qa.error.sessionExpired': "😅 I can't find the original conversation details. The session may have expired.",
  'qa.error.startUpdate': '😔 Something went wrong starting the document update. Please try again.',

  // --- How the asker is named in a shared Q&A ------------------------------
  // `sender.teamMember` is the name a *block* gives an anonymous asker;
  // `sender.anonymous` is the one the plain-text fallback gives them. They
  // differ in English today, so they stay two keys rather than one.
  'qa.share.sender.teamMember': 'A team member',
  'qa.share.sender.theTeamMember': 'The team member',
  'qa.share.sender.anonymous': 'Anonymous user',
  'qa.share.preview.senderPlaceholder': '(*{name}* OR *a team member*)',
  'qa.share.image.alt.profile': 'User profile',
  'qa.share.image.alt.anonymous': 'Anonymous user',

  // --- The Q&A as it is posted to the Q&A channel --------------------------
  'qa.share.channel.intro':
    'Hi, #{channelName} - {sender} asked the following question and this was my response.\n\n*Question:*\n{question}',
  'qa.share.channel.unanswered': 'However, I was not able to answer the question. Could anyone help?',
  'qa.share.channel.discuss': '{sender} would like to discuss this response with others. Could anyone help?',
  'qa.share.response': '*My response:*\n{response}',
  'qa.share.comment': '*{author} added:*\n{comment}',
  'qa.share.channel.preview.unanswered':
    'Hi, #{channelName}\n{sender} asked the following question and this was my response.\n\n*Question:*\n```{question}```\n\nHowever, I was not able to answer the question. Could anyone help?',
  'qa.share.channel.preview.answered':
    'Hi, #{channelName}\n{sender} asked the following question and this was my response.\n\n*Question:*\n```{question}```\n\n*My response:*\n```{response}```\n\nHowever, {sender} wants to discuss this with others. Could anyone help?',

  // --- The same Q&A as it is sent to a person in a DM ----------------------
  'qa.private.intro': 'Hi there!\n{sender} asked me the following question and shared my response with you.',
  'qa.private.question': '*Question:*\n{question}',
  'qa.private.unanswered':
    'However, I was not able to answer the question. The team member would like your help with this question.',
  'qa.private.discuss': '{sender} would like to discuss this with you. Could you help them?',
  'qa.private.anonymousReplyHint':
    '💬 *Want to reply to the questioner?*\nSimply respond in this thread! Your replies will be automatically forwarded to the anonymous questioner.',
  'qa.private.preview.unanswered':
    'Hi there!\n{sender} asked me the following question and shared my response with you.\n\n*Question:*\n```{question}```\n\nHowever, I was not able to answer the question. The team member would like your help with this question.',
  'qa.private.preview.answered':
    'Hi there!\n{sender} asked me the following question and shared my response with you.\n\n*Question:*\n```{question}```\n\n*My response:*\n```{response}```\n\nThe team member would like to discuss this with you. Could you help them?',

  // --- Modal chrome shared by both share modals ---------------------------
  'qa.shareModal.comment.label': '💭 Your Comment',
  'qa.shareModal.comment.placeholder': 'Add your thoughts or context about this question and answer (optional)',
  'qa.shareModal.privacy.label': '🎭 Privacy Options',
  'qa.shareModal.previewHeading': "👀 *Here's what will be shared:*",

  // --- "Share with Q&A" modal ---------------------------------------------
  'qa.channelModal.title': '📢 Share with Q&A',
  'qa.channelModal.submit': 'Post to Channel',
  'qa.channelModal.intro':
    '📢 *Ready to share this Q&A with #{channelName}?*\n_This will post the question and my response to help others in the channel. You can also add your own thoughts or context._',
  'qa.channelModal.anonymous.option': "Share anonymously (show as 'A team member' instead of your name)",

  // --- "Share with Q&A" submit --------------------------------------------
  'qa.channelSubmit.posted': '✅ Your Q&A has been posted to {channel}',
  'qa.channelSubmit.error': "❌ I couldn't post your Q&A to the configured Q&A channel. {reason}",
  'qa.channelSubmit.errorReason': 'Please check that I have access to the channel and try again.',
  'qa.channelSubmit.notInChannel':
    'The bot is not in the configured Q&A channel and cannot join automatically because the Slack app is missing the channels:join scope. Add channels:join and reinstall the app, or invite the bot to the Q&A channel manually.',

  // --- "Ask in Private" modal ---------------------------------------------
  'qa.othersModal.setup.text': '✅ Setting up private discussion...',
  'qa.othersModal.setup': '✅ *Setting up private discussion...*\nOpening participant selection modal.',
  'qa.othersModal.title': '🔒 Ask in Private',
  'qa.othersModal.submit': 'Send Privately',
  'qa.othersModal.intro':
    "🔒 *Who would you like to ask privately?*\n_They'll receive this Q&A as a direct message for private discussion. You can also add your own thoughts or context._",
  'qa.othersModal.people.label': '👤 People',
  'qa.othersModal.people.placeholder': 'Choose people to share with...',
  'qa.othersModal.anonymous.option': "Share anonymously (show as 'A team member' and exclude me from the DM)",

  // --- "Ask in Private" submit --------------------------------------------
  'qa.othersSubmit.threadGuide.text':
    'Feel free to discuss this question in this thread! Your responses will be automatically shared with the anonymous questioner.',
  'qa.othersSubmit.threadGuide':
    "👋 Feel free to discuss this question in this thread!\n\n💡 *Your responses will be automatically shared with the anonymous questioner.*\n\n🤖 *Need CHOIR to help?* Just mention me with `@choir` and I'll join the discussion!",
  'qa.othersSubmit.dmCreated.text': '✅ Private DM created with: {participants}',
  'qa.othersSubmit.dmCreated': '✅ *Private DM created*\n📋 Participants: {participants}',
  'qa.othersSubmit.dmReady.text': 'Access your private DM',
  'qa.othersSubmit.dmReady': '💬 *Your private DM is ready*\nClick the button below to open the conversation.',
  'qa.othersSubmit.openDm.button': 'Open DM',
  'qa.othersSubmit.dmFailed.text': "⚠️ I couldn't create the private DM. Please try again.",
  'qa.othersSubmit.dmFailed': "⚠️ *I couldn't create the private DM.* Please try again in a moment.",

  // --- Answering a question ------------------------------------------------
  'qa.answer.loading.text': 'Searching relevant documents and generating response... :mag: :brain:',
  'qa.answer.loading': ':mag: Searching relevant documents and analyzing context...',
  'qa.answer.indexing.text': 'Building the Q&A index and preparing your answer...',
  'qa.answer.indexing':
    ':hourglass_flowing_sand: The Q&A index is still being built, so this first answer may take a little longer. I’ll update this message when it’s ready.',
  'qa.answer.context.answered': "Answered {name}'s question",
  'qa.answer.context.responded': "Responded to {name}'s question",
  'qa.answer.sourcesHint':
    "If you'd like to read the original document, please refer to the sources linked in the reply.",
  'qa.answer.askChannel.button': 'Ask the Q&A Channel',
  'qa.answer.askPrivate.button': 'Ask in Private',
  'qa.answer.share.answered': '💡 Want to discuss this further or get additional insights from your team?',
  'qa.answer.share.unanswered':
    "💬 I couldn't find this information in our documentation. Would you like to ask your team directly?",
  'qa.answer.reference': '*Reference {index}*\n{source}\n```{content}```\n',
  'qa.answer.reference.source': '*Source:* {sources}\n',
  'qa.answer.error': 'Sorry, I encountered an error while processing your question. Please try again later.',

  // --- Turning replies into a document update ------------------------------
  'qa.managers.fallback': 'managers',
  'qa.managers.andOthers': '{name} and other managers',
  'qa.anonReply.analysis.text':
    "✅ Analysis Complete • 📊 10 messages analyzed\nSure! I'll suggest the following update to {managers}.",
  'qa.anonReply.analysis':
    "✅ *Analysis Complete* • 📊 10 messages analyzed\nSure! I'll suggest the following update to {managers}.",
  'qa.managerReply.analysis.text': '✅ Analysis Complete • 📊 10 messages analyzed',
  'qa.managerReply.analysis':
    "✅ *Analysis Complete* • 📊 10 messages analyzed\nSure! I'll suggest the following update to you.",
  'qa.dismissAnonymous.text': 'Thanks for the reply!',
  'qa.dismissAnonymous':
    '✅ *Thanks for the reply!*\nIf you need help with documentation updates in the future, just mention me.',
  'qa.dismissManager.text': 'Reply sent successfully!',
  'qa.dismissManager':
    '✅ *Reply successfully sent to the anonymous questioner!*\nIf you need help with documentation updates in the future, just mention me.',

  // --- DM feature: clearing CHOIR's messages from a DM ---------------------
  // The counts here are not plural entries: today's English says "1 recent
  // CHOIR messages", and the migration is not allowed to change a byte of it.
  // Turning them into `{ one, other }` is a separate, deliberate fix.
} as const;
