// Strings for the App Home index-management buttons.
// Keys: `indexManagement.<action>.<element>[.<variant>]`, one group per button:
//
//   reload     Reload from GitHub
//   rebuild    Rebuild QMD Index
//   normalize  Normalize Markdown Files
//   shared     the two refusals all three buttons can hit, word for word
//
// Each of these actions runs for a minute or more and narrates itself in the
// clicker's DM, so a message is either `progress.*` (sent before the work) or a
// result. Counted results are plural entries rather than `${n} files`, and the
// two that count twice in one sentence (`normalize.partial`,
// `rebuild.success.fallback`) take the counted phrases as slots, because a
// plural entry can only select on one `count`.
export const indexManagement = {
  'indexManagement.shared.error.noRepo': '❌ No GitHub repository connected. Please connect a repository first.',
  'indexManagement.shared.error.noMarkdownFiles': '❌ No markdown files found in the repository.',

  'indexManagement.reload.error.permission': "❌ You don't have permission to reload from GitHub.",
  'indexManagement.reload.progress.start': '🔄 Reloading files from GitHub...',
  'indexManagement.reload.success': {
    one: '✅ Successfully reloaded {count} file from GitHub and updated vector store!',
    other: '✅ Successfully reloaded {count} files from GitHub and updated vector store!',
  },
  'indexManagement.reload.error.vectorStore': '❌ Failed to update vector store with new files. Please check the logs.',
  'indexManagement.reload.error.generic': '❌ Error occurred while reloading from GitHub.',

  'indexManagement.rebuild.error.permission': "❌ You don't have permission to rebuild the QMD index.",
  'indexManagement.rebuild.error.noMirror': '❌ No synced markdown mirror found yet. Run Reload from GitHub first.',
  'indexManagement.rebuild.progress.fallback': '♻️ Rebuilding QMD index from the local markdown mirror...',
  'indexManagement.rebuild.progress.start':
    '♻️ *Rebuilding QMD index from the local markdown mirror...*\n\nThis may take a minute or two when QMD runs embeddings on CPU. I’ll send a success or error message when it finishes.',
  'indexManagement.rebuild.count.chunks': { one: '{count} chunk', other: '{count} chunks' },
  'indexManagement.rebuild.success.fallback':
    '✅ QMD index rebuilt successfully. Indexed {indexed} and embedded {chunks}.',
  'indexManagement.rebuild.success':
    '✅ *QMD index rebuilt successfully*\n*Indexed:* {indexed}\n*Updated:* {updated}\n*Unchanged:* {unchanged}\n*Removed:* {removed}\n*Docs embedded:* {docs}\n*Chunks embedded:* {chunks}',
  'indexManagement.rebuild.error.generic': '❌ Error occurred while rebuilding the QMD index.',

  'indexManagement.normalize.error.permission': "❌ You don't have permission to normalize markdown files.",
  'indexManagement.normalize.progress.start':
    '🔄 Starting markdown files normalization...\nThis may take a while depending on the number of files.',
  'indexManagement.normalize.error.noRepo':
    '❌ No GitHub repository connected. Please connect a repository first or ensure vector store has loaded files.',
  'indexManagement.normalize.progress.found': {
    one: '📄 Found {count} markdown file. Starting normalization...',
    other: '📄 Found {count} markdown files. Starting normalization...',
  },
  'indexManagement.normalize.success': {
    one: '✅ Successfully normalized {count} markdown file!\n\n🔄 Rebuilding vector store to reflect changes...',
    other: '✅ Successfully normalized {count} markdown files!\n\n🔄 Rebuilding vector store to reflect changes...',
  },
  'indexManagement.normalize.rebuilt': '✅ Vector store successfully rebuilt with normalized files!',
  'indexManagement.normalize.rebuildFailed':
    '⚠️ Markdown normalization completed, but vector store rebuild failed. Please rebuild manually.',
  'indexManagement.normalize.count.normalized': {
    one: '{count} file normalized',
    other: '{count} files normalized',
  },
  'indexManagement.normalize.count.failed': { one: '{count} file failed', other: '{count} files failed' },
  'indexManagement.normalize.partial':
    '⚠️ Normalization completed with issues:\n✅ {normalized}\n❌ {failed}\n\nPlease check the logs for details.',
  'indexManagement.normalize.error.generic':
    '❌ Error occurred while normalizing markdown files. Please check the logs.',
} as const;
