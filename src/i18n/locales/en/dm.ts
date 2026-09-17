// Strings for the dm feature (the `/clear`-style history reset in the bot DM).
// Keys: `dm.<surface>.<element>[.<variant>]`.
export const dm = {
  'dm.clear.noMessages': '💬 No messages found to clear.',
  'dm.clear.noChoirMessages.text': '💬 No CHOIR messages found to clear.',
  'dm.clear.noChoirMessages':
    '💬 No CHOIR messages found to clear.\n\n_Note: Only CHOIR messages can be deleted. User messages cannot be removed by the bot._',
  'dm.clear.confirm.text': '🗑️ Are you sure you want to clear {count} recent CHOIR messages?',
  'dm.clear.confirm':
    '🗑️ *Clear Recent CHOIR Messages*\n\nI found {total} total CHOIR messages in this conversation. I will delete the {count} most recent ones.\n\nAre you sure you want to delete them? This action cannot be undone.',
  'dm.clear.confirm.button': 'Yes, Clear {count} Recent',
  'dm.clear.error': '❌ Sorry, I encountered an error while trying to clear the chat. Please try again.',
  'dm.clear.progress.text': '🗑️ Clearing recent messages...',
  'dm.clear.progress': '🗑️ *Clearing {count} recent messages...*\nPlease wait while I delete the messages.',
  'dm.clear.failed.text': '❌ Failed to clear messages',
  'dm.clear.failed':
    '❌ *Failed to clear messages*\nSorry, I encountered an error while clearing the chat. Please try again.',
} as const;
